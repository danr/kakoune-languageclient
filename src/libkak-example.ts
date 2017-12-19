import * as process from 'process'
import * as libkak from './libkak'
import { Splice, Details } from './libkak'

let session = process.argv[2]

const { fifo, reply_fifo, handlers } = libkak.CreateHandler()

const { def, ask, def_sync, ask_sync } = libkak.KakouneBuddy<Splice>(Details, handlers, fifo, reply_fifo, (x: string) => {
  console.debug(x)
  libkak.MessageKakoune({ session }, x)
})

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

def_sync('js-eval-sync', '-params 1', ['1', 'client'], m => {
  console.log(m)
  const res = eval(m[1])
  console.log(res)
  return res
})

