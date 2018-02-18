import * as test from 'tape'
import * as libkak from '../src/libkak'
import {Splice, Kak} from '../src/libkak'

const debug = false

export function kaktest(
  name: string,
  cb: (kak: Kak<Splice>, t: test.Test, end: () => void) => void | Promise<any>
): void {
  test(name, (t: test.Test) => {
    t.timeoutAfter(1000)
    t.plan(1)
    const proc = libkak.Headless()
    const session = proc.pid
    const kak = Kak.Init(Splice, {session, client: 'unnamed0', debug})
    const end = () => (proc.kill(), kak.teardown(), t.end())
    cb(kak, t, end)
  })
}

export const example_strings = `
  simple
  c:d
  c|d
  c'd
  c"d
  c\\d
  '"\\:|
  c}d
`
  .split(/\s/gm)
  .filter(x => x.trim().length > 0)

example_strings.forEach(s => {
  kaktest(`content ${s}`, (kak, t, end) => {
    kak.msg(`exec i${s}<esc>`)
    kak.ask(['content'], m => {
      t.equal(m.content, `${s}\n`)
      end()
    })
  })
})

const all = Object.keys(libkak.Splice) as (keyof typeof libkak.Splice)[]

example_strings.forEach(entry => {
  const target = `a${entry}`
  const completions: libkak.Completion[] = [
    libkak.Completion(target, '_1', 'a1'),
    libkak.Completion('b2', '_2', 'b2'),
    libkak.Completion('c3', '_3', 'c3'),
    libkak.Completion('d4', '_4', 'd4'),
  ]

  kaktest(`complete ${entry}`, (kak, t, end) => {
    kak.ask(all, m => {
      const set = libkak.complete_reply('libkak_completions', {
        ...(m as any),
        cursor_column: 1,
        completions,
      })
      kak.def('failure', ['1'], m => (t.true(false, set), end()))
      kak.def('delay-pressing-c-n', [], m => {
        kak.msg_and_ask(`exec <c-n>`, ['content'], m => {
          t.is(m.content, `${target}\n`)
          end()
        })
      })
      kak.msg(`
        set global completers ''
        try %(
          ${set}
        ) catch %{
          failure
        }
        hook global InsertCompletionShow .* %{
          delay-pressing-c-n
        }
        exec i
      `)
    })
  })
})

kaktest('def_with_reply', (kak, t, end) => {
  kak.def_with_reply(
    'write-cursor',
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
  kaktest(`${N} asynchronous writes`, (kak, t, end) => {
    let seen = 0
    let expected_content = ''
    kak.def('write-msg -params 1', ['1'], m => {
      const w = m[1]
      kak.msg_and_ask(`exec ${w}g i ${w} <esc>`, [], () => {
        seen++
        if (seen == N) {
          kak.ask(['content'], m => {
            t.equal(m.content, expected_content)
            end()
          })
        }
      })
    })

    kak.msg(`exec ${N - 1}o<esc>`)

    for (let i = 1; i <= N; i++) {
      expected_content += `${i}\n`
      kak.msg(`write-msg ${i}`)
    }
  })
}

for (let N = 2; N <= 8; N += 2) {
  kaktest(`${N} simultaneous clients`, (kak, t, end) => {
    let seen = 0
    let expected_content = ''
    kak.def('write-msg -params 1', ['1', 'client'], m => {
      const w = m[1]
      const k = kak.focus(m.client)
      k.msg_and_ask(`exec ${w}g i %val{client} <esc>; quit`, [], () => {
        seen++
        if (seen == N) {
          kak.ask(['content'], m => {
            t.equal(m.content, expected_content)
            end()
          })
        }
      })
    })

    kak.msg(`exec ${N - 1}o<esc>`)

    const cbs: (() => void)[] = []

    let windows = 0
    kak.def('win-create', ['client'], m => {
      windows++
      if (windows == N) {
        cbs.forEach(cb => cb())
      }
    })

    kak.msg_and_ask(`hook global WinCreate .* win-create`, [], m => {
      for (let i = 1; i <= N; i++) {
        const name = `client${i}`
        libkak.Headless('json', '-c', kak.session, '-e', `rename-client ${name}`)
        cbs.push(() => {
          expected_content += `${name}\n`
          kak.focus(name).msg(`write-msg ${i}`)
        })
      }
    })
  })
}
