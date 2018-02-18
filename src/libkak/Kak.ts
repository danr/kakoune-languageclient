import * as cp from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

//////////////////////////////////////////////////////////////////////////////
// Simple communication

export interface MessageOptions {
  session: string | number
  client?: string
  try_client?: boolean
  debug?: boolean
}

/** Note: this is available as the `msg` property on Kak objects */
export function MessageKakoune(
  {session, client, try_client, debug}: MessageOptions,
  message: string
) {
  debug && console.error({session, client})
  debug && console.error(message)
  if (message.trim() == '') {
    return
  }
  if (client !== undefined) {
    const tmp = TempFile(message)
    const flag = try_client === false ? '-try-client' : '-client'
    MessageKakoune({session, debug}, `eval ${flag} ${client} %{%sh{cat ${tmp}; rm ${tmp}}}`)
  } else {
    const p = cp.execFile('kak', ['-p', session + ''])
    p.stdin.end(message)
  }
}

//////////////////////////////////////////////////////////////////////////////
// Details about how to pack and unpack spliced kakoune values

type Expand = ((s: string) => string)
type Embed = ((s: string) => string)
type Parse<Splice, K extends keyof Splice> = ((s: string) => Splice[K])
export interface Details<Splice, K extends keyof Splice> {
  expand: Expand
  embed: Embed
  parse: Parse<Splice, K>
}
export type Spliceable<Splice extends Record<string, any>> = {
  [K in keyof Splice]: Details<Splice, K>
}

export const splice = (expand: Expand) => <Splice, K extends keyof Splice>(
  k: K,
  parse: Parse<Splice, K>,
  embed: (s: string) => string = s => s
) => (({[k as string]: {expand, parse, embed}} as any) as Record<K, Details<Splice, K>>)

/** The Kak class

When initializing a Kak object it sets up a way to communicate with a running kakoune session.

It then provides an api to define commands, and message and query kakoune.

Internally it runs an event loop which handles the replies from kakoune
and runs the corresponding javascript callback on such a reply.

*/
export class Kak<Splice> {
  private constructor(
    private readonly details: Spliceable<Splice>,
    private readonly handlers: Record<string, any>,
    private readonly fifo: string,
    private readonly reply_fifo: string,
    private readonly options: MessageOptions,
    public readonly teardown: () => void
  ) {}

  focus(client: string | undefined) {
    return new Kak(
      this.details,
      this.handlers,
      this.fifo,
      this.reply_fifo,
      {...this.options, client},
      this.teardown
    )
  }

  msg(s: string): void {
    MessageKakoune(this.options, s)
  }

  get session(): string {
    return this.options.session + ''
  }

  /** Initialize a Kak object with a running kakoune session */
  static Init<Splice>(details: Spliceable<Splice>, options: MessageOptions): Kak<Splice> {
    const tmpdir = cp.execFileSync('mktemp', ['-d'], {encoding: 'utf8'}).trim()
    const fifo = path.join(tmpdir, 'fifo')
    const reply_fifo = path.join(tmpdir, 'replyfifo')
    cp.execFileSync('mkfifo', [fifo])
    cp.execFileSync('mkfifo', [reply_fifo])
    const debug = options && options.debug
    debug && console.error('created fifos:', {fifo, reply_fifo})
    debug && console.error({readdir: fs.readdirSync(tmpdir)})

    let torn_down = false
    const handlers: Record<string, any> = {}
    //////////////////////////////////////////////////////////////////////////////
    // Handle incoming requests from kakoune
    function read_loop() {
      fs.readFile(fifo, {encoding: 'utf8'}, (err, lines: string) => {
        if (err) {
          if (torn_down && err.code == 'ENOENT') {
            return
          }
          debug && console.error('read_loop error:', {err, torn_down})
          throw err
        } else {
          lines.split(/\n/g).forEach((line, i) => {
            if (line.length == 0) {
              debug && console.error('length 0:', {line, i})
              return
            }
            if (i > 0) {
              debug && console.error('multipacket', {line, i})
            }
            const maxlen = 160
            debug &&
              console.error(
                'From kakoune on fifo:',
                line.slice(0, maxlen),
                line.length > maxlen ? `(capped from ${line.length} to ${maxlen} chars)` : ``
              )
            try {
              const m = JSON.parse(line)
              const h = (handlers as any)[m['command']]
              h(m)
            } catch (e) {
              console.error(e.toString(), {line})
            }
          })
        }
        read_loop()
      })
    }

    read_loop()

    function teardown() {
      debug && console.error('teardown')
      torn_down = true
      fs.unlinkSync(fifo)
      fs.unlinkSync(reply_fifo)
      fs.rmdirSync(tmpdir)
      debug && console.error('teardown complete')
    }

    //////////////////////////////////////////////////////////////////////////////
    // Define helpers for json-wrapping

    const bs = '\\'
    MessageKakoune(
      options,
      `
      # mutates q register
      def -hidden -allow-override libkak-json-key-value -params 2 %{
        reg q %arg{2}
        exec -buffer *libkak-expand* 'gea,"' %arg{1} '":"__"<esc>hh"q<a-R>"p<a-Z>a'
      }
      # mutates p register
      def -hidden -allow-override libkak-json-escape %{
        try %{ exec '"pzs["${bs}${bs}]<ret>i${bs}<esc>' }
        try %{ exec '"pzs${bs}n<ret>c${bs}n<esc>' }
        try %{ exec '"pzs${bs}t<ret>c${bs}t<esc>' }
        try %{ exec '"pz;Ls.?${bs}K_<ret>d' }
      }`
    )

    return new Kak(details, handlers, fifo, reply_fifo, options, teardown)
  }

  private static command_counter = 0

  private run_query<K extends keyof Splice>(
    embed: (snippet: string) => string,
    one_shot: boolean,
    args: K[],
    on: (m: Pick<Splice, K>) => void
  ) {
    const command = '' + Kak.command_counter++
    const lsp_json_kvs = args
      .map(k =>
        this.details[k].embed(
          `libkak-json-key-value ${k == '"' ? '\\"' : k} ${this.details[k].expand(k)}`
        )
      )
      .join('\n    ')
    this.msg(
      embed(`
      eval -draft -no-hooks %(
        edit -debug -scratch *libkak-expand*
        exec '%di{"command":"${command}"'
      )
      eval -draft -no-hooks -save-regs pq %(
        reg p ''
        ${lsp_json_kvs}
        eval -buffer *libkak-expand* %(
          libkak-json-escape
          exec gea}<esc>
          exec \\% |cat>${this.fifo} <ret>
          delete-buffer!
        )
      )`)
    )
    this.handlers[command] = (parsed_json_line: Partial<Record<keyof Splice, string>>) => {
      const parsed_rhss: Pick<Splice, K> = {} as any
      args.forEach((k: K) => {
        const rhs = parsed_json_line[k]
        if (rhs === undefined) {
          throw 'Missing ' + k
        }
        parsed_rhss[k] = this.details[k].parse(rhs)
      })
      on(parsed_rhss)
      if (one_shot) {
        delete this.handlers[command]
      }
    }
  }

  private query<K extends keyof Splice>(args: K[]) {
    const parent = this
    let _embed = (s: string) => s
    let _on = (m: Pick<Splice, K>) => {
      return
    }
    let _one_shot = true
    return {
      /** Precomposition */
      embed(f: (s: string) => string) {
        _embed = compose(f, _embed)
        return this
      },
      on(f: (m: Pick<Splice, K>) => void) {
        _on = seq(_on, f)
        return this
      },
      run() {
        return parent.run_query(_embed, _one_shot, args, _on)
      },
      msg(msg: string) {
        this.embed(s => msg + '\n' + s)
        return this
      },
      def(command_name_and_params: string) {
        this.embed(s => `def -allow-override ${command_name_and_params} %(` + s + `)`)
        _one_shot = false
        return this
      },
      with_reply(h: (m: Pick<Splice, K>) => string) {
        this.embed(s => s + `; %sh{ cat ${parent.reply_fifo} }`)
        this.on(m => {
          let reply = `echo -debug "libkak.ts AskKakouneWithReply request failed"`
          try {
            reply = h(m)
          } finally {
            fs.appendFileSync(parent.reply_fifo, reply)
          }
        })
        return this
      },
    }
  }

  /* // These don't work properly, the read_loop never terminates
  Ask<K extends keyof Splice>(args: K[]): Promise<Pick<Splice, K>> {
    return new Promise(k => this.query(args).on(m => k(m)).run())
  }
  MsgAndAsk<K extends keyof Splice>(msg: string, args: K[]): Promise<Pick<Splice, K>> {
    return new Promise(k => this.query(args).msg(msg).on(m => k(m)).run())
  }
  */

  msg_and_then(msg: string, then: () => void) {
    this.query([])
      .msg(msg)
      .on(() => then())
      .run()
  }
  msg_with_reply(msg: string, then: () => string) {
    this.query([])
      .msg(msg)
      .with_reply(() => then())
      .run()
  }
  ask<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => void) {
    this.query(args)
      .on(on)
      .run()
  }
  ask_with_reply<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => string) {
    this.query(args)
      .with_reply(on)
      .run()
  }
  msg_and_ask<K extends keyof Splice>(msg: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    this.query(args)
      .msg(msg)
      .on(on)
      .run()
  }
  msg_and_ask_with_reply<K extends keyof Splice>(
    msg: string,
    args: K[],
    on: (m: Pick<Splice, K>) => string
  ) {
    this.query(args)
      .msg(msg)
      .with_reply(on)
      .run()
  }
  def<K extends keyof Splice>(
    command_name_and_params: string,
    args: K[],
    on: (m: Pick<Splice, K>) => void
  ) {
    this.query(args)
      .on(on)
      .def(command_name_and_params)
      .run()
  }
  def_with_reply<K extends keyof Splice>(
    command_name_and_params: string,
    args: K[],
    on: (m: Pick<Splice, K>) => string
  ) {
    this.query(args)
      .with_reply(on)
      .def(command_name_and_params)
      .run()
  }
}

//////////////////////////////////////////////////////////////////////////////
// Utils

function compose<A, B, C>(f: (b: B) => C, g: (a: A) => B) {
  return (a: A) => f(g(a))
}

function seq<A>(f: (a: A) => void, g: (a: A) => void) {
  return (a: A) => (f(a), g(a))
}

export function TempFile(contents: string): string {
  const filename = cp.execFileSync('mktemp', {encoding: 'utf8'}).trim()
  fs.writeFileSync(filename, contents)
  return filename
}
