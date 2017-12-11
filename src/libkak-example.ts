import * as process from 'process'
import * as libkak from './libkak'
import { Splice, Details } from './libkak'

const session = process.argv[2]

const { fifo, handlers } = libkak.CreateHandler()

const { def } = libkak.KakouneBuddy<Splice>(Details, handlers, fifo, (x: string) => {
  console.log(x)
  libkak.MessageKakoune({ session }, x)
})

def('what-buffile', '', ['buffile'], m => console.log(m.buffile))
def('what-selection', '', ['selection'], m => console.log(m.selection))
def('standard', '', libkak.StandardKeys, m => console.log(m))
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

