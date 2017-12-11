import * as jsonrpc from 'vscode-jsonrpc'
import * as ls from 'vscode-languageserver'
import * as lsp from 'vscode-languageserver-protocol'
import * as lspt from 'vscode-languageserver-types'
import * as rpc from 'vscode-jsonrpc';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as process from 'process'
import * as libkak from './libkak'
import { Splice, Details, subkeys, Standard, StandardKeys } from './libkak'

const session = process.argv[2]

const { fifo, handlers } = libkak.CreateHandler()

const { def, ask } = libkak.KakouneBuddy<Splice>(Details, handlers, fifo, (x: string) => {
  console.log(x)
  libkak.MessageKakoune({ session }, x)
})

console.log('spawning')
const child = cp.spawn('typescript-language-server', ['--stdio'],
  {
    detached: true,
    stdio: 'pipe'
  }
)

const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(child.stdout),
  new rpc.StreamMessageWriter(child.stdin));


console.log('running')

function OnNotification<P, RO>(type: lsp.NotificationType<P, RO>, handler: lsp.NotificationHandler<P>): void {
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

connection.onNotification((method: string, ...params: any[]) => console.log('notification', method, JSON.stringify(params)))
connection.onRequest((method: string, ...params: any[]) => console.log('request', method))

connection.listen();


const didOpen = (params: {textDocument: lspt.TextDocumentItem}) => {
  const m = new rpc.NotificationType<typeof params, true>('textDocument/didOpen')
  connection.sendNotification(m, params)
}

function SendRequest<P, R, E, RO>(type: lsp.RequestType<P, R, E, RO>, params: P, token?: lsp.CancellationToken): Thenable<R> {
  return connection.sendRequest(type, params, token)
}

function SendNotification<P, RO>(type: lsp.NotificationType<P, RO>): (params: P) => void {
  return params => connection.sendNotification(type, params)
}

SendRequest(lsp.InitializeRequest.type, {
  processId: process.pid,
  rootUri: 'file:///home/dan/code/kakoune-languageclient/',
  capabilities: {},
  trace: 'verbose'
}).then(
  (x: any) => console.log('initialized:', x)
  || SendNotification(lsp.DidOpenTextDocumentNotification.type)({
    textDocument: {
      uri: 'file:///home/dan/code/kakoune-languageclient/src/main.ts',
      languageId: 'typescript',
      version: 0,
      text: 'const n: string = 1 + 2'
    }
  })
)


function Uri(d: Pick<Standard, 'buffile'>): lsp.TextDocumentIdentifier {
  return {
    uri: 'file:///' + d.buffile
  }
}

function Pos(d: Pick<Standard, 'cursor_line' | 'cursor_column' | 'buffile'>): lsp.TextDocumentPositionParams {
  return {
    textDocument: Uri(d),
    position: {
      line: d.cursor_line - 1,
      character: d.cursor_column - 1
    }
  }
}

const file_version: Record<string, number> = {}

function Sync(m: Standard) {
  if (!file_version[m.buffile]) {
    const version = file_version[m.buffile] = 1
    SendNotification(lsp.DidOpenTextDocumentNotification.type)({
      textDocument: {
        version,
        languageId: m.filetype,
        ...Uri(m),
        text: m.selection
      }
    })
  } else {
    const version = file_version[m.buffile]++
    SendNotification(lsp.DidChangeTextDocumentNotification.type)({
      textDocument: { version, ...Uri(m) },
      contentChanges: [{ text: m.selection }]
    })
  }
}

def('lsp-hover', '-params 0..1',
  subkeys(Details, '1', ...StandardKeys),
  m => {
    Sync(m)
    SendRequest(lsp.HoverRequest.type, Pos(m)).then(value => {
      console.group('hover')
      console.log(value.range)
      console.log(value.contents)
      console.groupEnd()
    })
  })
