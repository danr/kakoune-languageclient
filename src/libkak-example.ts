import * as process from 'process'
import * as libkak from './libkak'
import {Splice, Kak} from './libkak'

if (!process.argv[2]) {
  console.error('Need one argument: the kak session to connect to')
  process.exit(1)
}

const session = process.argv[2]

const kak = Kak.Init(Splice, {
  session,
  client: 'unnamed0',
  debug: true,
})

kak.def('what-buffile', ['buffile'], m => console.log(m.buffile))
kak.def('what-selection', ['selection'], m => console.log(m.selection))
// example: js-eval '"hello World!".split("").map(x => `exec a${x.charCodeAt(0)}_<esc>`).join(";")'
kak.def('js-eval -params 1', ['1', 'client'], m => {
  console.log(m)
  try {
    const res = eval(m[1])
    libkak.MessageKakoune({session, client: m.client, debug: true}, res)
  } catch (e) {
    console.log(e)
  }
})

kak.def_with_reply('js-eval-sync -params 1', ['1', 'client'], m => {
  console.log(m)
  const res = eval(m[1])
  console.log(res)
  return res
})

const all = Object.keys(Splice) as (keyof typeof Splice)[]

kak.def_with_reply('complete', all, m => {
  console.error(m)
  const completions: libkak.Completion[] = [
    libkak.Completion('a2longlong', 'help 1', 'a2 (function)'),
    libkak.Completion('a2longlong', 'help 2', 'a2 (function)'),
    libkak.Completion('a2longlong', 'help 3', 'a2 (function)'),
    libkak.Completion('a2longlong', 'help 4', 'a2 (function)'),
    libkak.Completion('b1longlong', 'help 1', 'b1 (function)'),
    libkak.Completion('b2longlong', 'help 2', 'b1 (function)'),
    libkak.Completion('b3longlong', 'help 3', 'b1 (function)'),
    libkak.Completion('b4longlong', 'help 4', 'b1 (function)'),
    libkak.Completion('c1longlong', 'help 1', 'c1 (function)'),
    libkak.Completion('c1longlong', 'help 2', 'c2 (function)'),
    libkak.Completion('c1longlong', 'help 3', 'c3 (function)'),
    libkak.Completion('c1longlong', 'help 4', 'c4 (function)'),
  ]
  const reply = libkak.complete_reply('libkak_completions', {
    ...(m as any),
    cursor_column: m.cursor_column - 1,
    completions,
  })
  console.error({reply})
  return reply
})
kak.msg(`
    hook global InsertChar [a-z] %{
        complete
    }
`)
