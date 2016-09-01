'use strict'

var electron = require('electron-prebuilt')
var spawn = require('cross-spawn')
var path = require('path')
var EventEmitter = require('events')

var headless
try { headless = require('headless') } catch (err) {}

module.exports = function (opts) {
  return new Daemon(opts)
}

var i = 0

class Daemon extends EventEmitter {
  constructor (opts) {
    super()
    opts = opts || {}
    this.daemonMain = opts.daemonMain || path.join(__dirname, '..', 'app', 'daemon.js')
    opts.timeout = typeof opts.timeout === 'number'
      ? opts.timeout : 10e3
    opts.windowOpts = opts.windowOpts || { show: false, skipTaskbar: true }
    opts.headless = opts.headless != null
      ? opts.headless : process.env.HEADLESS
    if (opts.headless == null && process.platform === 'linux') {
      opts.headless = true
    }

    this.queue = []
    this.ready = false
    this.closing = false

    if (opts.headless) {
      this._startHeadless((err) => {
        if (err) return this.emit('error', err)
        this._startElectron(opts)
      })
    } else {
      this._startElectron(opts)
    }
  }

  eval (code, opts = {}, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = {}
    }
    var id = (i++).toString(36)
    this.once(id, (res) => {
      if (res.err) {
        var target = opts.mainProcess ? 'main process' : 'window'
        var err = new Error(`Error evaluating "${code}" ` +
          `in "${target}": ${res.err}`)
        err.original = res.err
      }
      if (cb) {
        if (err) return cb(err)
        return cb(null, res.res)
      }
      if (err) this.emit('error', err)
    })
    if (!this.ready) return this.queue.push([ code, opts, cb ])
    this.child.send({ id, opts, code })
  }

  keepalive () {
    this.child.send(0)
  }

  close (signal) {
    this.closing = true
    if (this.xvfb) {
      process.kill(this.xvfb.pid, 'SIGKILL')
    }
    this.child.kill(signal)
    this.stdout = this.stdin = null
    this.eval = (code, cb) => cb && cb(new Error('Daemon already closed'))
    clearInterval(this.keepaliveInterval)
  }

  _startHeadless (cb) {
    if (headless == null) {
      return cb(new Error('Could not load "headless" module'))
    }
    var opts = { display: { width: 1024, height: 768, depth: 24 } }
    headless(opts, (err, child, display) => {
      if (err) {
        var err2 = new Error(`Could not start Xvfb: "${err.message}". \n` +
        'The "xvfb" package is required to run "electron-eval" on Linux. ' +
        'Please install it first ("sudo apt-get install xvfb").')
        return cb(err2)
      }
      process.on('exit', () => {
        if (this.closing) return
        process.kill(child.pid, 'SIGKILL')
      })
      this.xvfb = child
      this.xDisplay = `:${display}`
      cb(null)
    })
  }

  _startElectron (opts, cb) {
    var env = {}
    var exitStderr = ''
    if (this.xDisplay) env.DISPLAY = this.xDisplay
    this.child = spawn(opts.electron || electron, [ this.daemonMain ], { env, stdio: ['ipc'] })
    this.child.on('close', (code) => {
      if (this.closing) return
      var err = `electron-eval error: Electron process exited with code ${code}`
      if (exitStderr) err += `.\nStderr:\n${exitStderr}`
      this.emit('error', new Error(err))
    })
    this.child.on('error', (err) => this.emit('error', err))
    this.child.stderr.on('data', (data) => {
      exitStderr += `${data.toString()}${exitStderr ? '\n' : ''}`
    })

    process.on('exit', () => this.child.kill())

    this.child.once('message', (data) => {
      this.keepaliveInterval = setInterval(this.keepalive.bind(this), opts.timeout / 2)
      this.keepaliveInterval.unref()
      this.child.send(opts)
      this.child.once('message', (data) => {
        this.child.on('message', (message) => this.emit(message[0], message[1]))
        this.ready = true
        this.queue.forEach((item) => this.eval(...item))
        this.queue = null
        this.emit('ready')
        this.keepalive()
      })
    })
  }
}
