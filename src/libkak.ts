import * as fs from 'fs'
import * as child_process from 'child_process'
import * as path from 'path'

//////////////////////////////////////////////////////////////////////////////
// Simple communication

export interface CommunicationOptions {
  session: string | number
  client?: string
  try_client?: boolean
  debug?: boolean
}

export function MessageKakoune(
  {session, client, try_client, debug}: CommunicationOptions,
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
// Messages to kakoune

const ask_kakoune = <Splice>(
  details: SpliceDetails<Splice>,
  handler_map: Record<string, (p: Partial<Record<keyof Splice, string>>) => void>,
  fifo: string,
  reply_fifo: string, // for synchronous asks
  snippet_cb: (kak_snippet: string) => void
) => {
  const bs = '\\'
  snippet_cb(`
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
  function AskKakoune<K extends keyof Splice>(
    embed: (snippet: string) => string,
    command: string,
    args: K[],
    on: (m: Pick<Splice, K>) => void
  ) {
    const lsp_json_kvs = args
      .map(k => details[k].embed(`libkak-json-key-value ${k} ${details[k].expand(k)}`))
      .join('\n    ')
    snippet_cb(
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
          echo -debug fifo:${fifo}
          exec \\% |tee <space> ${fifo} <ret>
          # write ${fifo}
        )
      )`)
    )
    handler_map[command] = (parsed_json_line: Partial<Record<keyof Splice, string>>) => {
      const parsed_rhss: Pick<Splice, K> = {} as any
      args.forEach((k: K) => {
        const rhs = parsed_json_line[k]
        if (rhs === undefined) {
          throw 'Missing ' + k
        }
        parsed_rhss[k] = details[k].parse(rhs)
      })
      on(parsed_rhss)
    }
  }
  function AskKakouneWithReply<K extends keyof Splice>(
    embed: (snippet: string) => string,
    command: string,
    args: K[],
    on: (m: Pick<Splice, K>) => string
  ) {
    return AskKakoune(s => embed(s + `; %sh{ cat ${reply_fifo} }`), command, args, m => {
      let reply = `echo -debug "libkak.ts AskKakouneWithReply request ${command} failed"`
      try {
        reply = on(m)
      } finally {
        fs.appendFileSync(reply_fifo, reply)
      }
    })
  }
  let ask_counter = 0
  return {
    ask<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => void) {
      const command_name = '__ask__' + ask_counter++
      AskKakoune(id, command_name, args, m => (on(m), delete handler_map[command_name]))
    },
    ask_with_reply<K extends keyof Splice>(args: K[], on: (m: Pick<Splice, K>) => string) {
      const command_name = '__ask__' + ask_counter++
      AskKakouneWithReply(id, command_name, args, m => {
        const s = on(m)
        delete handler_map[command_name]
        return s
      })
    },
    def<K extends keyof Splice>(
      command_name: string,
      params: string,
      args: K[],
      on: (m: Pick<Splice, K>) => void
    ) {
      AskKakoune(
        s => `def -allow-override ${command_name} ${params} %(` + s + `)`,
        command_name,
        args,
        on
      )
    },
    def_with_reply<K extends keyof Splice>(
      command_name: string,
      params: string,
      args: K[],
      on: (m: Pick<Splice, K>) => string
    ) {
      AskKakouneWithReply(
        s => `def -allow-override ${command_name} ${params} %(` + s + `)`,
        command_name,
        args,
        on
      )
    },
    msg: snippet_cb,
  }
}

//////////////////////////////////////////////////////////////////////////////
// Handle incoming requsts and replies from kakoune

function handle_incoming(options?: {debug?: boolean}) {
  const tmpdir = child_process.execFileSync('mktemp', ['-d'], {encoding: 'utf8'}).trim()
  const fifo = path.join(tmpdir, 'fifo')
  const reply_fifo = path.join(tmpdir, 'replyfifo')
  child_process.execFileSync('mkfifo', [fifo])
  child_process.execFileSync('mkfifo', [reply_fifo])
  const debug = (options && options.debug) || false
  debug && console.error('created fifos:', {fifo, reply_fifo})
  debug && console.error({readdir: fs.readdirSync(tmpdir)})

  let torn_down = false
  const handlers = {}
  ;(function read_loop() {
    fs.readFile(fifo, {encoding: 'utf8'}, (err, line: string) => {
      if (err) {
        if (torn_down && err.code == 'ENOENT') {
          return
        }
        debug && console.error('read_loop error:', {err, torn_down})
        throw err
      } else {
        const maxlen = 160
        debug &&
          console.log(
            'From kakoune on fifo:',
            line.slice(0, maxlen),
            `(capped from ${line.length} to maxlen chars)`
          )
        const m = JSON.parse(line)
        const h = (handlers as any)[m['command']]
        h(m)
      }
      read_loop()
    })
  })()

  function teardown() {
    debug && console.error('teardown')
    torn_down = true
    fs.unlinkSync(fifo)
    fs.unlinkSync(reply_fifo)
    fs.rmdirSync(tmpdir)
  }

  return {fifo, reply_fifo, handlers, teardown}
}

//////////////////////////////////////////////////////////////////////////////
// Initiate the communication

export function Init<Splice>(details: SpliceDetails<Splice>, options: CommunicationOptions) {
  const h = handle_incoming(options)
  const snippet_cb = (s: string) => MessageKakoune(options, s)
  const kak = ask_kakoune(details, h.handlers, h.fifo, h.reply_fifo, snippet_cb)
  return {...kak, teardown: h.teardown}
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
    return 'menu ' + options.map(opt => quote(opt.title) + ' ' + quote(opt.command)).join(' ')
  }
}

export type InfoPlacement = 'above' | 'below' | 'info' | 'docsclient'

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
    case 'info':
      return `info ${quote(msg)}`
    case 'above':
    case 'below':
      return `info -placement ${where} -anchor ${format_pos(pos || zero)} ${quote(msg)}`
  }
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
