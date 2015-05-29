var run = require('comandante')
var _ = require('lodash')
var Q = require('kew')
var ipfs = require('ipfs-api')
var waterfall = require('promise-waterfall')
var freeport = require('freeport')
var shutdown = require('shutdown-handler')
var rimraf = require('rimraf')
var fs = require('fs')

function configureNode (node, conf, cb) {
  waterfall(_.map(conf, function (value, key) {
    return function () {
      var def = Q.defer()
      run('ipfs', ['config', key, value], {env: node.env})
        .on('error', cb)
        .on('end', function () { def.resolve() })
      return def.promise
    }
  })).then(function () {
    cb(null, true)
  })
}

function tempDir () {
  return '/tmp/ipfs_' + (Math.random() + '').substr(2)
}

var Node = function (path, opts, disposable) {
  var env = _.clone(process.env)
  env.IPFS_PATH = path
  return {
    clean: true,
    pid: null,
    path: path,
    opts: opts,
    env: env,
    init: function (cb) {
      var t = this
      if (!cb) cb = opts
      var buf = ''
      run('ipfs', ['init'], {env: t.env})
        .on('error', cb)
        .on('data', function (data) { buf += data })
        .on('end', function () {
          configureNode(t, t.opts, function (err) {
            if (err) return cb(err)
            t.clean = false
            cb(null, t)
          })
        })
      shutdown.on('exit', t.shutdown.bind(t))
    },
    shutdown: function (e) {
      var t = this

      if (!t.clean && disposable) {
        e.preventDefault()
        rimraf(t.path, function (err) {
          if (err) throw err
          process.exit(0)
        })
      } else if (t.pid) {
        e.preventDefault()
        run('kill', [t.pid], {env: t.env})
          .on('error', function (err) { throw err })
          .on('end', function () { process.exit(0) })
      }
    },
    daemon: function (cb) {
      var t = this
      var running = run('ipfs', ['daemon'], {env: t.env})
      t.pid = running.pid
      running
        .on('error', function (err) {
          if ((err+'').match('daemon is running')) {
            // we're good
            cb(null)
          } else {
            cb(err)
          }
        })
        .on('data', function (data) {
          var match = (data + '').trim().match(/API server listening on/)
          if (match) {
            // FIXME: https://github.com/ipfs/go-ipfs/issues/1288
            setTimeout(function () {
              cb(null)
            }, 100)
          }
        })
    },
    getConf: function (key, cb) {
      var t = this
      var result = ''
      run('ipfs', ['config', key], {env: t.env})
        .on('error', cb)
        .on('data', function (data) { result += data })
        .on('end', function () { cb(null, result.trim()) })
    },
    stop: function (cb) {
      var t = this
      if (this.pid) {
        run('kill', [this.pid])
          .on('error', cb)
          .on('end', function () {
            t.pid = null
            cb(null)
          })
      } else {
        // not started, no problem
        cb(null)
      }
    }
  }
}

// cb for consistent error handling
var parseConfig = function (path, cb) {
  try {
    var file = fs.readFileSync(path + '/config')
    var parsed = JSON.parse(file)
    cb(null, parsed)
  } catch (e) {
    cb(e)
  }
}

module.exports = {
  local: function (cb) {
    var path = process.env.IPFS_PATH ||
      (process.env.HOME ||
       process.env.USERPROFILE) + '/.ipfs'

    parseConfig(path, function (err, conf) {
      var apiAddr
      if (err.code !== 'EACCESS') {
        // could be first run, no problem
        apiAddr = '/ip4/127.0.0.1/tcp/5001'
      } else if (err) {
        return cb(err)
      }
      if (!apiAddr) {
        apiAddr = conf.Addresses.API
      }

      var node = new Node(path, {})
      node.daemon(function (err) {
        if (err) return cb(err)
        cb(null, ipfs(apiAddr))
      })
    })
  },
  disposableApi: function (cb) {
    this.disposable(function (err, node) {
      if (err) return cb(err)
      cb(null, ipfs(node.opts['Addresses.API']))
    })
  },
  disposable: function (cb) {
    freeport(function (err, port) {
      if (err) return cb(err)
      var node = new Node(tempDir(),
                          {'Addresses.Gateway': '""',
                           'Addresses.API': '/ip4/127.0.0.1/tcp/' + port},
                          true)
      node.init(function (err, newnode) {
        if (err) return cb(err)
        node.daemon(function (err) {
          if (err) return cb(err)
          cb(null, node)
        })
      })
    })
  }
}
