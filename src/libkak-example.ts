import * as process from 'process'
import * as libkak from './libkak'
import { Splice, Details } from './libkak'

if (!process.argv[2]) {
  console.error('Need one argument: the kak session to connect to')
  process.exit(1)
}

const session = process.argv[2]

const { def, ask, def_with_reply, ask_with_reply } =
  libkak.Init(Details, {session, client: 'unnamed0', debug: true})

def('what-buffile', '', ['buffile'], m => console.log(m.buffile))
def('what-selection', '', ['selection'], m => console.log(m.selection))
// example: js-eval '"hello World!".split("").map(x => `exec a${x.charCodeAt(0)}_<esc>`).join(";")'
def('js-eval', '-params 1', ['1', 'client'], m => {
  console.log(m)
  try {
    const res = eval(m[1])
    libkak.MessageKakoune({ session, client: m.client, debug: true }, res)
  } catch (e) {
    console.log(e)
  }
})

def_with_reply('js-eval-sync', '-params 1', ['1', 'client'], m => {
  console.log(m)
  const res = eval(m[1])
  console.log(res)
  return res
})

