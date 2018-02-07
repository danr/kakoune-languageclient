import * as test from 'tape'
import * as libkak from '../src/libkak'
import {Splice, Details} from '../src/libkak'

test('libkak', t => {
  t.plan(1)
  t.timeoutAfter(1000)
  const proc = libkak.Headless()
  const session = proc.pid

  const kak = libkak.Init(Details, {session, client: 'unnamed0'})

  kak.def_with_reply(
    'write-cursor',
    '',
    ['selection_desc'],
    m => `exec a ${libkak.format_cursor(m.selection_desc)} <esc>`
  )

  kak.msg(`
    write-cursor
    exec a <space> <esc>
    write-cursor
  `)

  kak.ask(['content'], m => {
    t.equal(m.content, '1.1,1.1 1.7,1.8\n')
    proc.kill()
    kak.teardown()
  })
})
