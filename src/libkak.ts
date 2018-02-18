import * as fs from 'fs'
import * as child_process from 'child_process'
import * as path from 'path'

//////////////////////////////////////////////////////////////////////////////
// Simple communication

export interface MessageSettings {
  session: string | number
  client?: string
  try_client?: boolean
  debug?: boolean
}

/** Note: this is available as the `msg` property on Kak objects */
export function MessageKakoune(
  {session, client, try_client, debug}: MessageSettings,
  message: string
) {
  debug && console.error({session, client, message})
  if (message.trim() == '') {
    return
  }
  if (client !== undefined) {
    const tmp = TempFile(message)
    const flag = try_client === false ? '-try-client' : '-client'
    MessageKakoune({session, debug}, `eval ${flag} ${client} %{%sh{cat ${tmp}; rm ${tmp}}}`)
  } else {
    const p = child_process.execFile('kak', ['-p', session + ''])
    p.stdin.end(message)
  }
}

//////////////////////////////////////////////////////////////////////////////
// Buddy protocol types

export type Expand = ((s: string) => string)
export type Embed = ((s: string) => string)
export type Parse<Splice, K extends keyof Splice> = ((s: string) => Splice[K])
export interface Details<Splice, K extends keyof Splice> {
  expand: Expand
  embed: Embed
  parse: Parse<Splice, K>
}
export type SpliceDetails<Splice extends Record<string, any>> = {
  [K in keyof Splice]: Details<Splice, K>
}

export const splice = (expand: Expand) => <Splice, K extends keyof Splice>(
  k: K,
  parse: Parse<Splice, K>,
  embed: (s: string) => string = s => s
) => (({[k as string]: {expand, parse, embed}} as any) as Record<K, Details<Splice, K>>)

export const keyed = <Splice, K extends keyof Splice>(
  k: K,
  expansion: string,
  parse: Parse<Splice, K>,
  embed: (s: string) => string = s => s
) => splice(_ => expansion)<Splice, K>(k, parse, embed)

export const val = splice(s => '%val(' + s + ')')
export const arg = splice(s => '%arg(' + s + ')')
export const opt = splice(s => '%opt(' + s + ')')
export const reg = splice(s => '%reg(' + s + ')')
export const client_env = splice(s => '%val(client_env_' + s + ')')
export const id = <A>(a: A) => a

/** FIXME: does not handle list items with escaped colons due to missing lookbacks in js regex */
export const colons = (s: string) => s.split(':')

export const subkeys = <S extends Record<string, any>, K extends keyof S>(m: S, ...ks: K[]) => ks

//////////////////////////////////////////////////////////////////////////////
// Communicating with

function compose<A,B,C>(f: (b: B) => C, g: (a: A) => B) {
  return (a: A) => f(g(a))
}
function seq<A>(f: (a: A) => void, g: (a: A) => void) {
  return (a: A) =>(f(a), g(a))
}

/** The Kak class

When initializing a Kak object it sets up a way to communicate with a running kakoune session.

It then provides an api to define commands, and message and query kakoune.

Internally it runs an event loop which handles the replies from kakoune
and runs the corresponding javascript callback on such a reply.

*/
export class Kak<Splice> {
  /** Initialize a Kak object with a running kakoune session */
  static Init<Splice>(details: SpliceDetails<Splice>, options: MessageSettings): Kak<Splice> {
    const tmpdir = child_process.execFileSync('mktemp', ['-d'], {encoding: 'utf8'}).trim()
    const fifo = path.join(tmpdir, 'fifo')
    const reply_fifo = path.join(tmpdir, 'replyfifo')
    child_process.execFileSync('mkfifo', [fifo])
    child_process.execFileSync('mkfifo', [reply_fifo])
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

    return new Kak(details, handlers, fifo, reply_fifo, teardown, (s: string) =>
      MessageKakoune(options, s)
    )
  }

  private constructor(
    private readonly details: SpliceDetails<Splice>,
    private readonly handlers: Record<string, any>,
    private readonly fifo: string,
    private readonly reply_fifo: string,
    public readonly teardown: () => void,
    public readonly msg: (s: string) => void
  ) {
    const bs = '\\'
    msg(`
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
      }`)
  }

  private command_counter = 0

  private run_query<K extends keyof Splice>(
    embed: (snippet: string) => string,
    one_shot: boolean,
    args: K[],
    on: (m: Pick<Splice, K>) => void
  ) {
    const command = '' + this.command_counter++
    const lsp_json_kvs = args
      .map(k => this.details[k].embed(`libkak-json-key-value ${k} ${this.details[k].expand(k)}`))
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
          echo -debug fifo:${this.fifo}
          exec \\% |cat>${this.fifo} <ret>
          delete-buffer!
          # write ${this.fifo}
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
    let _on = (m: Pick<Splice, K>) => { return }
    let _one_shot = true
    return {
      /** Precomposition */
      embed(f: (s: string) => string)         { _embed = compose(f, _embed); return this },
      on(f: (m: Pick<Splice, K>) => void) { _on = seq(_on, f); return this },
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
      }
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

  ask<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => void) {
    this.query(args).on(on).run()
  }
  ask_with_reply<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => string) {
    this.query(args).with_reply(on).run()
  }
  msg_and_ask<K extends keyof Splice>(msg: string, args: K[], on: (m: Pick<Splice, K>) => void) {
    this.query(args).msg(msg).on(on).run()
  }
  msg_and_ask_with_reply<K extends keyof Splice>(
    msg: string,
    args: K[],
    on: (m: Pick<Splice, K>) => string
  ) {
    this.query(args).msg(msg).with_reply(on).run()
  }
  def<K extends keyof Splice>(
    command_name_and_params: string,
    args: K[],
    on: (m: Pick<Splice, K>) => void
  ) {
    this.query(args).on(on).def(command_name_and_params).run()
  }
  def_with_reply<K extends keyof Splice>(
    command_name_and_params: string,
    args: K[],
    on: (m: Pick<Splice, K>) => string
  ) {
    this.query(args).with_reply(on).def(command_name_and_params).run()
  }
}

//////////////////////////////////////////////////////////////////////////////
// Standard splice type

export interface Splice {
  buffile: string
  timestamp: number
  session: string
  client: string
  /** buffer content */
  content: string
  selection: string
  /** todo: split at non backslash-escaped : */
  selections: string[]
  selection_desc: Cursor
  selections_desc: Cursor[]
  cursor_line: number
  cursor_column: number
  filetype: string
  1: string
  completers: string[]
}

export const Details: SpliceDetails<Splice> = {
  ...val('buffile', id),
  ...val('session', id),
  ...val('client', id),
  ...val('timestamp', parseInt),
  ...val('cursor_line', parseInt),
  ...val('cursor_column', parseInt),
  ...keyed('content', '%val(selection)', id, s => `eval -draft %(exec '%'; ${s})`),
  ...val('selection', id),
  ...val('selection', id),
  ...val('selections', colons),
  ...val('selection_desc', parse_cursor),
  ...val('selections_desc', s => s.split(':').map(parse_cursor)),
  ...opt('filetype', id),
  ...arg('1', id),
  ...opt('completers', colons),
}

//////////////////////////////////////////////////////////////////////////////
// Make strings to send to kakoune

export function quote(msg: string) {
  // https://github.com/mawww/kakoune/issues/1049
  return (
    "'" +
    msg
      .replace("\\'", "\\\\'")
      .replace("'", "\\'")
      .replace(/\\*$/, '') +
    "'"
  )
}

export interface Pos {
  line: number
  column: number
}

export function format_pos(pos: Pos): string {
  return `${pos.line}.${pos.column}`
}

export function parse_pos(s: string): Pos {
  const [line, column] = s.split('.').map(s => parseInt(s, 10))
  return {line, column}
}

export const zero: Pos = {
  line: 1,
  column: 1,
}

export const zero_indexed = (p: Pos) => ({line: p.line - 1, character: p.column - 1})
export const one_indexed = (p: {line: number; character: number}): Pos => ({
  line: p.line + 1,
  column: p.character + 1,
})

export interface Cursor {
  anchor: Pos
  head: Pos
}

export function format_cursor(cursor: Cursor) {
  return format_pos(cursor.anchor) + ',' + format_pos(cursor.head)
}

export function parse_cursor(s: string): Cursor {
  const [anchor, head] = s.split(',').map(parse_pos)
  return {anchor, head}
}

export function menu(options: {title: string; command: string}[]) {
  if (options.length == 1) {
    return options[0].command
  } else {
    const m =  'menu ' + options.map(opt => quote(opt.title) + ' ' + quote(opt.command)).join(' ')
    console.error({menu: m})
    return m
  }
}

export type InfoPlacement = 'above' | 'below' | 'info' | 'docsclient' | 'statusline'

export function info(msg: string, where: InfoPlacement = 'info', pos?: Pos): string {
  if (msg.trim() == '') {
    return ''
  }
  switch (where) {
    case 'docsclient':
      const tmp = TempFile(msg)
      return `eval -no-hooks -try-client %opt{docsclient} %{
        edit! -scratch '*libkak-doc*'
        exec \%d|cat<space> ${tmp}<ret>
        exec \%|fmt<space> - %val{window_width} <space> -s <ret>
        exec gg
        set buffer filetype rst
        try %{rmhl window/number_lines}
        %sh{rm ${tmp}}
      }`
    case 'statusline':
      return `echo ${quote(msg.replace(/\s+/gm, ' '))}`
    case 'info':
      return `info ${quote(msg)}`
    case 'above':
    case 'below':
      return `info -placement ${where} -anchor ${format_pos(pos || zero)} ${quote(msg)}`
  }
}

export interface CompletionContext {
  cursor_line: number
  cursor_column: number
  timestamp: number
  completions: Completion[]
}

export interface Completion {
  /** the inserted text */
  insert: string
  /** the help text */
  help: string
  /** what is written in the completions menu */
  entry: string
}

export function Completion(insert: string, help: string, entry: string) {
  return {insert, help, entry}
}

export function format_complete(cc: CompletionContext) {
  const format_completion = (c: Completion) =>
    [c.insert, c.help, c.entry].map(s => s.replace(/[|:\\]/g, x => '\\' + x)).join('|')
  const rows = cc.completions.map(format_completion).join(':')
  return `${cc.cursor_line}.${cc.cursor_column}@${cc.timestamp}:${rows}`
}

export function complete_reply(
  optname: string,
  cc: CompletionContext & {completers: string[]; buffile: string}
) {
  let setup = ''
  const opt = `option=${optname}`
  const buffer = quote('buffer=' + cc.buffile)
  if (-1 == cc.completers.indexOf(opt)) {
    setup += `try %{ decl completions ${optname} };`
    setup += `set ${buffer} completers ${opt};`
    // NB: no -add, we prevent all other completers for now
  }
  return setup + `set ${buffer} ${optname} ${quote(format_complete(cc))}`
  // todo: lsp-complete fetch documentation when index in completion list changes
}

//////////////////////////////////////////////////////////////////////////////
// File utils

export function TempFile(contents: string): string {
  const filename = child_process.execFileSync('mktemp', {encoding: 'utf8'}).trim()
  fs.writeFileSync(filename, contents)
  return filename
}

export const Headless = (ui: string = 'dummy') => {
  const kak = child_process.execFile('kak', ['-n', '-ui', ui])
  return {
    pid: kak.pid,
    kill() {
      kak.kill()
    },
  }
}
