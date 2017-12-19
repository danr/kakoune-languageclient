import * as test from 'tape'
import * as libkak from '../src/libkak'
import { Splice, Details } from '../src/libkak'

test('libkak', assert => {
  const proc = libkak.Headless()

  const kak = libkak.Init(Details, { session: proc.pid + '', client: 'unnamed0' })

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
    proc.kill()
    kak.teardown()
  })
})
