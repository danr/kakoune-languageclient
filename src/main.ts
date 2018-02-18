import * as jsonrpc from 'vscode-jsonrpc'
import Uri from 'vscode-uri'
import * as ls from 'vscode-languageserver'
import * as lsp from 'vscode-languageserver-protocol'
import * as lspt from 'vscode-languageserver-types'
import {Position} from 'vscode-languageserver-types'
import * as rpc from 'vscode-jsonrpc'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import * as process from 'process'
import * as libkak from './libkak'
import {Splice, Details, subkeys, Kak} from './libkak'
import * as util from 'util'
util.inspect.defaultOptions.depth = 5

const session = process.argv[2]
const server = process.argv[3]
const proto_args = process.argv.slice(4)
const args = proto_args.filter(arg => arg != '-d')

const debug = proto_args.some(arg => arg == '-d')
const debug_values = debug
const debug_out = debug
const debug_to_kakoune = debug
const debug_connection = debug

if (!session || !server) {
  console.error(`Need two arguments:

    <kak session>
    <server command>

  Example:

    yarn run 4782 javascript-typescript-stdio

  (which can be installed with

    yarn global add javascript-typescript-langserver

  )

  Add -d for debug output`)
  process.exit(1)
}

const kak = Kak.Init(Details, {
  session,
  debug,
})

console.log('spawning')
const child = cp.spawn(server, args, {
  detached: true,
  stdio: 'pipe',
})

const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(child.stdout),
  new rpc.StreamMessageWriter(child.stdin)
)

console.log('running')

function OnNotification<P, RO>(
  type: lsp.NotificationType<P, RO>,
  handler: lsp.NotificationHandler<P>
): void {
  return connection.onNotification(type, handler)
}

OnNotification(lsp.ShowMessageNotification.type, params => {
  if (debug_connection) {
    console.group('notification', params.type)
    console.log(params.message)
    console.groupEnd()
  }
})

OnNotification(lsp.PublishDiagnosticsNotification.type, params => {
  if (debug_connection) {
    console.group('diagnostics', params.uri)
    params.diagnostics.forEach(d => {
      console.log(d.range)
      console.log(d.message)
    })
    console.groupEnd()
  }
})

connection.onNotification(
  (method: string, ...params: any[]) =>
    debug_connection && console.log('notification', method, JSON.stringify(params))
)
connection.onRequest(
  (method: string, ...params: any[]) => debug_connection && console.log('request', method)
)

connection.listen()

function SendRequest<P, R, E, RO>(
  type: lsp.RequestType<P, R, E, RO>,
  params: P,
  token?: lsp.CancellationToken
): Thenable<R> {
  return connection.sendRequest(type, params, token)
}

function SendNotification<P, RO>(type: lsp.NotificationType<P, RO>): (params: P) => void {
  return params => connection.sendNotification(type, params)
}

SendRequest(lsp.InitializeRequest.type, {
  processId: process.pid,
  rootUri: 'file://' + process.cwd(),
  capabilities: {},
  trace: 'verbose',
}).then((x: lsp.InitializeResult) => {
  console.log('initialized:', x)
  const comp = x.capabilities.completionProvider
  if (comp) {
    const chars = (comp.triggerCharacters || []).join('')
    kak.msg(`
      hook -group lsp global InsertChar [${chars}] %{exec '<a-;>: lsp-complete<ret>'}
    `)
  }
  const sig = x.capabilities.signatureHelpProvider
  if (sig) {
    const chars = (sig.triggerCharacters || []).join('')
    kak.msg(`
      hook -group lsp global InsertChar [${chars}] %{exec ': lsp-signature-help<ret>'}
    `)
  }
})

function Id(d: Pick<Standard, 'buffile'>): lsp.TextDocumentIdentifier {
  return {
    uri: Uri.file(d.buffile).toString(),
  }
}

function Pos(
  d: Pick<Standard, 'cursor_line' | 'cursor_column' | 'buffile'>
): lsp.TextDocumentPositionParams {
  return {
    textDocument: Id(d),
    position: {
      line: d.cursor_line - 1,
      character: d.cursor_column - 1,
    },
  }
}

function linelimit(limit: number, msg: string): string {
  return msg
    .split(/\n/)
    .slice(0, limit)
    .join('\n')
}

const StandardKeys = subkeys(
  Details,
  'buffile',
  'client',
  'timestamp',
  'cursor_line',
  'cursor_column',
  'content',
  'filetype'
)

type StandardKeys = typeof StandardKeys[0]

type Standard = Pick<Splice, StandardKeys>

const file_version: Record<string, number> = {}

function Sync(m: Standard) {
  // alternative and faster way: write the buffer to a temp file or fifo that we read here
  // + only do it if timestamp has changed (or history id?)
  if (!file_version[m.buffile]) {
    const version = (file_version[m.buffile] = 1)
    SendNotification(lsp.DidOpenTextDocumentNotification.type)({
      textDocument: {
        version,
        languageId: m.filetype,
        ...Id(m),
        text: m.content,
      },
    })
  } else {
    const version = file_version[m.buffile]++
    SendNotification(lsp.DidChangeTextDocumentNotification.type)({
      textDocument: {version, ...Id(m)},
      contentChanges: [{text: m.content}],
    })
  }
}

function Hover({contents}: lspt.Hover): string {
  if (typeof contents == 'string') {
    return contents
  } else if (Array.isArray(contents)) {
    return contents.length == 0 ? '' : Hover({contents: contents[0]})
  } else {
    return contents.value
  }
}

function Sig(value: lspt.SignatureHelp) {
  return value.signatures
    .map((sig, i) => {
      if (i == value.activeSignature) {
        const parameters = sig.parameters || []
        return [
          '> ' + sig.label,
          sig.documentation || '',
          ...parameters.map(
            (param, j) =>
              (j == value.activeParameter ? '> ' : '  ') + param.label + ' ' + param.documentation
          ),
        ].join('\n  ')
      } else {
        return sig.label
      }
    })
    .join('\n')
}

function Completions(value: lspt.CompletionList | lspt.CompletionItem[]): libkak.Completion[] {
  const items = Array.isArray(value) ? value : value.items
  const maxlen = Math.max(0, ...items.map(item => item.label.length))
  return items.map(item => CompleteItem(item, maxlen))
}

const completion_kinds = {
  1: 'Text',
  2: 'Method',
  3: 'Function',
  4: 'Constructor',
  5: 'Field',
  6: 'Variable',
  7: 'Class',
  8: 'Interface',
  9: 'Module',
  10: 'Property',
  11: 'Unit',
  12: 'Value',
  13: 'Enum',
  14: 'Keyword',
  15: 'Snippet',
  16: 'Color',
  17: 'File',
  18: 'Reference',
}

function CompleteItem(item: lspt.CompletionItem, maxlen: number): libkak.Completion {
  const {label, kind, detail, documentation, insertText} = item
  const insert = insertText || label
  const help = [detail || '', documentation || ''].filter(x => x).join('\n\n')
  const info = kind ? completion_kinds[kind] : ''
  const entry = label + ' '.repeat(maxlen - label.length) + ' {MenuInfo}' + info
  return {insert, help, entry}
}

function select(range: lspt.Range): string {
  const start = libkak.format_pos(libkak.one_indexed(range.start))
  const end = libkak.format_pos(
    libkak.one_indexed({...range.end, character: range.end.character - 1})
  )
  return `select ${start},${end}`
}

function edit_uri_select(uri_string: string, range: lspt.Range): string {
  const uri = Uri.parse(uri_string)
  if (uri.scheme === 'file') {
    return `edit ${uri_string.slice('file://'.length)}; ${select(range)}`
  } else {
    return `echo -markup {red}Cannot open ${uri_string}`
    return `echo debug Cannot open ${uri_string}`
  }
}

function def<K extends keyof Splice, I>(
  command_name_and_params: string,
  args: K[],
  on: (m: Pick<Splice, K>) => Thenable<I>,
  cont: (k: Kak<Splice>, m: Pick<Splice, K>, i: I) => void
) {
  kak.def(command_name_and_params, args, async m => {
    const i = await on(m)
    console.log(JSON.stringify(i))
    cont(kak.focus(m.client), m, i)
  })
  kak.def(`debug-${command_name_and_params}`, args, m => {
    const k = kak.focus(m.client)
    k.ask(['"', 'client'], dq => {
      try {
        const i: I = JSON.parse(dq['"']) as any
        cont(k, m, i)
      } catch (e) {
        k.msg(`echo ${libkak.quote(e.toString())}`)
        k.msg(
          `
            echo -debug debugging failed, put an object in %reg{"}:
            echo -debug ${libkak.quote(e.toString())}
          `
        )
      }
    })
  })
}

def(
  'lsp-hover -params 0..1',
  subkeys(Details, '1', ...StandardKeys),
  m => (Sync(m), SendRequest(lsp.HoverRequest.type, Pos(m))),
  (k, m, value) => {
    debug_values && console.dir({hover: value})
    const msg = linelimit(25, Hover(value))
    const where = (m[1] as libkak.InfoPlacement) || 'info'
    const pos = value.range ? value.range.start : Pos(m).position
    debug_out && console.log({msg, where, pos})
    k.msg(libkak.info(msg, where, libkak.one_indexed(pos)))
  }
)

def(
  'lsp-signature-help -params 0..1',
  subkeys(Details, '1', ...StandardKeys),
  m => (Sync(m), SendRequest(lsp.SignatureHelpRequest.type, Pos(m))),
  (k, m, value) => {
    SendRequest(lsp.SignatureHelpRequest.type, Pos(m))
    debug_values && console.dir({sig: value})
    const msg = linelimit(25, Sig(value))
    const where = (m[1] as libkak.InfoPlacement) || 'info'
    const pos = Pos(m).position
    k.msg(libkak.info(msg, where, libkak.one_indexed(pos)))
  }
)

def(
  'lsp-complete',
  subkeys(Details, 'completers', ...StandardKeys),
  m => (Sync(m), SendRequest(lsp.CompletionRequest.type, Pos(m))),
  (k, m, value) => {
    debug_values && console.dir({complete: value})
    const cc = {...m, completions: Completions(value)}
    k.msg(libkak.complete_reply('lsp_completions', cc))
    // todo: lsp-complete fetch documentation when index in completion list changes
  }
)

def(
  'lsp-goto-definition',
  StandardKeys,
  m => (Sync(m), SendRequest(lsp.DefinitionRequest.type, Pos(m))),
  (k, m, value) => {
    debug_values && console.dir({definition: value})
    if (value === null) {
      k.msg(`No definition site found!`)
      return
    }
    const locs = Array.isArray(value) ? value : [value]
    const menu = libkak.menu(
      locs.map(loc => ({
        title: loc.uri + ':' + (loc.range.start.line + 1),
        command: edit_uri_select(loc.uri, loc.range),
      }))
    )
    k.msg(menu)
  }
)
