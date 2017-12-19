import * as test from 'tape'
import * as libkak from '../src/libkak'
import { Splice, Details } from '../src/libkak'

test('libkak', assert => {
  const kak_process = libkak.Headless()
  const session = kak_process.pid + ''

  const { fifo, reply_fifo, handlers, teardown } = libkak.CreateHandler()

  const kak = libkak.KakouneBuddy<Splice>(Details, handlers, fifo, reply_fifo, (x: string) => {
    x = 'set global debug commands|shell; ' + x
    libkak.MessageKakoune({ session, client: 'unnamed0' }, x)
  })

  kak.def_with_reply('write-cursor', '', ['selection_desc'],
    m => `exec a ${libkak.format_cursor(m.selection_desc)} <esc>`)

  kak.msg(`
    write-cursor
    exec a <space> <esc>
    write-cursor
  `)

  assert.plan(1)
  assert.timeoutAfter(1000)
  kak.ask(['content'], m => {
    assert.equal(m.content, '1.1,1.1 1.7,1.8\n')
    kak_process.kill()
    teardown()
  })
})
