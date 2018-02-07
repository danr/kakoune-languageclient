import * as jsonrpc from 'vscode-jsonrpc'
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
import {Splice, Details, subkeys} from './libkak'
import * as util from 'util'
util.inspect.defaultOptions.depth = 5

if (!process.argv[2]) {
  console.error('Need one argument: the kak session to connect to')
  process.exit(1)
}

let session = process.argv[2] || ''
const debug = true

const kak = libkak.Init(Details, {
  session,
  client: 'unnamed0',
  debug: true,
})

console.log('spawning')
const child = cp.spawn('javascript-typescript-stdio', [], {
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
  console.group('notification', params.type)
  console.log(params.message)
  console.groupEnd()
})

OnNotification(lsp.PublishDiagnosticsNotification.type, params => {
  console.group('diagnostics', params.uri)
  params.diagnostics.forEach(d => {
    console.log(d.range)
    console.log(d.message)
  })
  console.groupEnd()
})

connection.onNotification((method: string, ...params: any[]) =>
  console.log('notification', method, JSON.stringify(params))
)
connection.onRequest((method: string, ...params: any[]) => console.log('request', method))

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
}).then((x: any) => console.log('initialized:', x))

function Uri(d: Pick<Standard, 'buffile'>): lsp.TextDocumentIdentifier {
  return {
    uri: 'file://' + d.buffile,
  }
}

function Pos(
  d: Pick<Standard, 'cursor_line' | 'cursor_column' | 'buffile'>
): lsp.TextDocumentPositionParams {
  return {
    textDocument: Uri(d),
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
        ...Uri(m),
        text: m.content,
      },
    })
  } else {
    const version = file_version[m.buffile]++
    SendNotification(lsp.DidChangeTextDocumentNotification.type)({
      textDocument: {version, ...Uri(m)},
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

function Complete(value: lspt.CompletionList | lspt.CompletionItem[]) {
  const items = Array.isArray(value) ? value : value.items
  const maxlen = Math.max(0, ...items.map(item => item.label.length))
  return items.map(item => CompleteItem(item, maxlen).replace(/:/g, '\\:')).join(':')
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

function CompleteItem(item: lspt.CompletionItem, maxlen: number): string {
  const {label, kind, detail, documentation, insertText} = item
  const insert = insertText || label
  const doc = [detail || '', documentation || ''].filter(x => x).join('\n\n')
  const info = kind ? completion_kinds[kind] : ''
  const entry = label + ' '.repeat(maxlen - label.length) + ' {MenuInfo}' + info
  return [insert, doc, entry].map(x => x.replace(/([|:])/g, s => '\\' + s)).join('|')
}

const reply = ({client}: {client: string}, message: string) =>
  libkak.MessageKakoune({session, client, debug: true}, message)

kak.def('lsp-hover', '-params 0..1', subkeys(Details, '1', ...StandardKeys), async m => {
  Sync(m)
  const value = await SendRequest(lsp.HoverRequest.type, Pos(m))
  console.dir({hover: value})
  const msg = linelimit(25, Hover(value))
  const where = (m[1] as libkak.InfoPlacement) || 'info'
  const pos = value.range ? value.range.start : Pos(m).position
  console.log({msg, where, pos})
  reply(m, libkak.info(msg, where, libkak.one_indexed(pos)))
})

kak.def('lsp-signature-help', '-params 0..1', subkeys(Details, '1', ...StandardKeys), async m => {
  Sync(m)
  const value = await SendRequest(lsp.SignatureHelpRequest.type, Pos(m))
  console.dir({sig: value})
  const msg = linelimit(25, Sig(value))
  const where = (m[1] as libkak.InfoPlacement) || 'info'
  const pos = Pos(m).position
  reply(m, libkak.info(msg, where, libkak.one_indexed(pos)))
})
;`enable with something like:

  hook -group lsp buffer InsertChar [.] '<a-;>: lsp-complete<ret>'

`
kak.def('lsp-complete', '', subkeys(Details, 'completers', ...StandardKeys), async m => {
  Sync(m)
  const value = await SendRequest(lsp.CompletionRequest.type, Pos(m))
  console.dir({complete: value})
  const optname = 'lsp_completions'
  const opt = `option=${optname}`
  const setup =
    -1 == m.completers.indexOf(opt) ? `set -add buffer=${m.buffile} completers ${opt};` : ''
  const rhs = `${m.cursor_line}.${m.cursor_column}@${m.timestamp}:${Complete(value)}`
  console.log({optname, opt, setup, rhs})
  reply(m, setup + `set buffer=${m.buffile} ${optname} ${libkak.quote(rhs)}`)
  // todo: lsp-complete fetch documentation when index in completion list changes
})
