import * as test from 'tape'
import * as libkak from '../src/libkak'
import {Splice, Details, Kak} from '../src/libkak'

const debug = false

function kaktest(
  name: string,
  cb: (kak: Kak<Splice>, t: test.Test, end: () => void) => void
): void {
  test(name, t => {
    t.timeoutAfter(1000)
    const proc = libkak.Headless()
    const session = proc.pid
    const kak = Kak.Init(Details, {session, client: 'unnamed0', debug})
    cb(kak, t, () => (proc.kill(), kak.teardown(), t.end()))
  })
}

;['simple', `{}:"'\\`].map(s => {
  kaktest(`content ${s}`, (kak, t, end) => {
    kak.msg(`exec i${s}<esc>`)
    kak.ask(['content'], m => {
      t.equal(m.content, `${s}\n`)
      end()
    })
  })
})

kaktest('def_with_reply', (kak, t, end) => {
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
    end()
  })
})

for (let N = 4; N <= 16; N += 4) {
  kaktest(`def ${N} writes (asynchronous)`, (kak, t, end) => {
    let seen = 0
    let content = ''
    kak.msg(`exec ${N - 1}o<esc>`)
    kak.def('write-msg', '-params 1', ['1'], m => {
      kak.msg(`exec ${m[1]}g i ${m[1]} <esc>; seen ${m[1]}`)
      // this detour via seen is a little bit silly
      // but I don't have a msg_with_reply nor ask_with_reply_and_msg
    })

    kak.def('seen', '-params 1', ['1'], m => {
      seen++
      if (seen == N) {
        kak.ask(['content'], m => {
          t.equal(m.content, content)
          end()
        })
      }
    })

    for (let i = 1; i <= N; i++) {
      content += `${i}\n`
      kak.msg(`write-msg ${i}`)
    }
  })
}
