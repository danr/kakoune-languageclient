import * as jsonrpc from 'vscode-jsonrpc'
import * as ls from 'vscode-languageserver'
import * as lsp from 'vscode-languageserver-protocol'
import * as lspt from 'vscode-languageserver-types'
import * as cp from 'child_process';
import * as rpc from 'vscode-jsonrpc';

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

function SendNotification<P, RO>(type: lsp.NotificationType<P, RO>, params: P): void {
  return connection.sendNotification(type, params)
}

SendRequest(lsp.InitializeRequest.type, {
  processId: process.pid,
  rootUri: 'file:///home/dan/code/kakoune-languageclient/',
  capabilities: {},
  trace: 'verbose'
}).then(
  (x: any) => console.log('initialized:', x)
  || SendNotification(lsp.DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: 'file:///home/dan/code/kakoune-languageclient/src/main.ts',
      languageId: 'typescript',
      version: 0,
      text: 'const n: string = 1 + 2'
    }
  })
)

type Splices = 'buffile' | 'timestamp'

interface Splice {
  buffile: string,
  timestamp: number,
  client: string,
  selection: string,
  cursor_line: number,
  cursor_column: number,
  filetype: string,
  1: string,
}

const splice_map: {[k in keyof Splice]?: string} = {}

function splice(expand: ((s: string) => string)): <K extends keyof Splice>(x: K, k: (s: string) => Splice[K]) => K {
  return (x, k) => (splice_map[x] = expand(x), x)
}

const val = splice(s => '%val{' + s + '}')
const arg = splice(s => '%arg{' + s + '}')
const opt = splice(s => '%opt{' + s + '}')
const reg = splice(s => '%reg{' + s + '}')
const client_env = splice(s => '%val{client_env_' + s + '}')
function splices<K extends keyof Splice>(...xs: K[]): K[] {
  return xs
}

const id = <A>(a: A) => a

const buffile = val('buffile', id)
const client = val('client', id)
const timestamp = val('timestamp', parseInt)
const cursor_line = val('cursor_line', parseInt)
const cursor_column = val('cursor_column', parseInt)
const selection = val('selection', id)
const filetype = opt('filetype', id)
const arg1 = arg('1', id)
const standard = splices(buffile, timestamp, client, cursor_line, cursor_column)

function Register<K extends keyof Splice>(command_name: string, args: K[], on: (interpolated: Pick<Splice, K>) => void) {
  const w = (x: string) => console.log(x)
  w(`def -allow-override ` + command_name + ` %{`)
  w(`  eval -no-hooks -save-regs pq %{`)
  w(`    reg p ""`)
  args.forEach((k, i) => {
    w(`    reg q ` + splice_map[k])
    w(`    exec -no-hooks -buffer *expand* '` + (i == 0 ? '\\%di{' : 'i,') + `"` + k + `":"X"q<a-R>aX<esc>"p<a-z>aa"<esc>'`)
  })
  w(`    try %{ exec -no-hooks '"pzs["\\\\]<ret>i\\<esc>' }`)
  w(`    try %{ exec -no-hooks '"pzs\\n<ret>c\\n<esc>' }`)
  w(`    try %{ exec -no-hooks '"pzs\\t<ret>c\\t<esc>' }`)
  w(`    try %{ exec -no-hooks '"pzsX\\z<ret>d' }`)
  w(`  }`)
  w(`  eval -no-hooks -buffer *expand* %{ write %opt{lsp_fifo} }`)
  w(`}`)
}

function Uri(d: Pick<Splice, 'buffile'>): lsp.TextDocumentIdentifier {
  return {
    uri: 'file:///' + d.buffile
  }
}

function Pos(d: Pick<Splice, 'cursor_line' | 'cursor_column' | 'buffile'>): lsp.TextDocumentPositionParams {
  return {
    textDocument: Uri(d),
    position: {
      line: d.cursor_line - 1,
      character: d.cursor_column - 1
    }
  }
}

Register(
  'lsp-hover -params 0..1',
  splices(arg1, ...standard),
  m => {
    SendRequest(lsp.HoverRequest.type, Pos(m)).then(value => {
      console.group('hover')
      console.log(value.range)
      console.log(value.contents)
      console.groupEnd()
    })
  })


