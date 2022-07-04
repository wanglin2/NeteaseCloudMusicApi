const fs = require('fs')
const path = require('path')
const express = require('express')
const request = require('./util/request')
const packageJSON = require('./package.json')
const exec = require('child_process').exec
const cache = require('./util/apicache').middleware
const { cookieToJson } = require('./util/index')
const fileUpload = require('express-fileupload')
const decode = require('safe-decode-uri-component')

/**
 * The version check result.
 * @readonly
 * @enum {number}
 */
const VERSION_CHECK_RESULT = {
  FAILED: -1,
  NOT_LATEST: 0,
  LATEST: 1,
}

/**
 * @typedef {{
 *   identifier?: string,
 *   route: string,
 *   module: any
 * }} ModuleDefinition
 */

/**
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   checkVersion?: boolean,
 *   moduleDefs?: ModuleDefinition[]
 * }} NcmApiOptions
 */

/**
 * @typedef {{
 *   status: VERSION_CHECK_RESULT,
 *   ourVersion?: string,
 *   npmVersion?: string,
 * }} VersionCheckResult
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

/**
 * Get the module definitions dynamically.
 *
 * @param {string} modulesPath The path to modules (JS).
 * @param {Record<string, string>} [specificRoute] The specific route of specific modules.
 * @param {boolean} [doRequire] If true, require() the module directly.
 * Otherwise, print out the module path. Default to true.
 * @returns {Promise<ModuleDefinition[]>} The module definitions.
 *
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(
  modulesPath,
  specificRoute,
  doRequire = true,
) {
  const files = await fs.promises.readdir(modulesPath)
  const parseRoute = (/** @type {string} */ fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

  const modules = files
    .reverse()
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const identifier = file.split('.').shift()
      const route = parseRoute(file)
      const modulePath = path.join(modulesPath, file)
      const module = doRequire ? require(modulePath) : modulePath

      return { identifier, route, module }
    })

  return modules
}

/**
 * Check if the version of this API is latest.
 *
 * @returns {Promise<VersionCheckResult>} If true, this API is up-to-date;
 * otherwise, this API should be upgraded and you would
 * need to notify users to upgrade it manually.
 */
async function checkVersion() {
  return new Promise((resolve) => {
    exec('npm info NeteaseCloudMusicApi version', (err, stdout) => {
      if (!err) {
        let version = stdout.trim()

        /**
         * @param {VERSION_CHECK_RESULT} status
         */
        const resolveStatus = (status) =>
          resolve({
            status,
            ourVersion: packageJSON.version,
            npmVersion: version,
          })

        resolveStatus(
          packageJSON.version < version
            ? VERSION_CHECK_RESULT.NOT_LATEST
            : VERSION_CHECK_RESULT.LATEST,
        )
      }
    })

    resolve({
      status: VERSION_CHECK_RESULT.FAILED,
    })
  })
}

/**
 * Construct the server of NCM API.
 *
 * @param {ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @returns {Promise<import("express").Express>} The server instance.
 */
async function consturctServer(moduleDefs) {
  // 创建一个应用
  const app = express()

  // 设置为true，则客户端的IP地址被理解为X-Forwarded-*报头中最左边的条目
  app.set('trust proxy', true)

  /**
   * 配置CORS & 预检请求
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true, // 跨域情况下，允许客户端携带验证信息，比如cookie，同时，前端发送请求时也需要设置withCredentials: true
        'Access-Control-Allow-Origin': req.headers.origin || '*', // 允许跨域请求的域名，设置为*代表允许所有域名
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type', // 用于给预检请求(options)列出服务端允许的自定义标头，如果前端发送的请求中包含自定义的请求标头，且该标头不包含在Access-Control-Allow-Headers中，那么该请求无法成功发起
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS', // 设置跨域请求允许的请求方法理想
        'Content-Type': 'application/json; charset=utf-8', // 设置响应数据的类型及编码
      })
    }
    // OPTIONS为预检请求，复杂请求会在发送真正的请求前先发送一个预检请求，获取服务器支持的Access-Control-Allow-xxx相关信息，判断后续是否有必要再发送真正的请求，返回状态码204代表请求成功，但是没有内容
    req.method === 'OPTIONS' ? res.status(204).end() : next()
  })

  /**
   * 解析Cookie
   */
  app.use((req, _, next) => {
    req.cookies = {}
    //;(req.headers.cookie || '').split(/\s*;\s*/).forEach((pair) => { //  Polynomial regular expression //
    // 从请求头中读取cookie，cookie格式为：name=value;name2=value2...，所以先根据;切割为数组
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      let crack = pair.indexOf('=')
      // 没有值的直接跳过
      if (crack < 1 || crack == pair.length - 1) return
      // 将cookie保存到cookies对象上
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(
        pair.slice(crack + 1),
      ).trim()
    })
    next()
  })

  /**
   * 请求体解析和文件上传处理
   */
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(fileUpload())

  /**
   * 将public目录下的文件作为静态文件提供
   */
  app.use(express.static(path.join(__dirname, 'public')))

  /**
   * 缓存请求，两分钟内同样的请求会从缓存里读取数据，不会向网易云音乐服务器发送请求
   */
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200))

  /**
   * 特殊路由
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * 加载/module目录下的所有模块，每个模块对应一个接口
   */
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, 'module'), special))

  for (const moduleDef of moduleDefinitions) {
    // 注册路由
    app.use(moduleDef.route, async (req, res) => {
      // cookie也可以从查询参数、请求体上传来
      ;[req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      // 把cookie、查询参数、请求头、文件都整合到一起，作为参数传给每个模块
      let query = Object.assign(
        {},
        { cookie: req.cookies },
        req.query,
        req.body,
        req.files,
      )

      try {
        // 执行模块方法，即发起对网易云音乐接口的请求
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // 参数注入客户端IP
          const obj = [...params]
          // 处理ip，为了实现IPv4-IPv6互通，IPv4地址前会增加::ffff:
          let ip = req.ip
          if (ip.substr(0, 7) == '::ffff:') {
            ip = ip.substr(7)
          }
          obj[3] = {
            ...obj[3],
            ip,
          }
          return request(...obj)
        })
        console.log('[OK]', decode(req.originalUrl))

        // 请求成功后，获取响应中的cookie，并且通过Set-Cookie响应头来将这个cookie设置到前端浏览器上
        const cookies = moduleResponse.cookie
        if (Array.isArray(cookies) && cookies.length > 0) {
          if (req.protocol === 'https') {
            // 去掉跨域请求cookie的SameSite限制，这个属性用来限制第三方Cookie，从而减少安全风险
            res.append(
              'Set-Cookie',
              cookies.map((cookie) => {
                return cookie + '; SameSite=None; Secure'
              }),
            )
          } else {
            res.append('Set-Cookie', cookies)
          }
        }
        // 以网易云音乐接口返回的状态码和响应体响应请求
        res.status(moduleResponse.status).send(moduleResponse.body)
      } catch (/** @type {*} */ moduleResponse) {
        // 请求失败处理
        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        // 没有响应体，返回404
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          })
          return
        }
        // 301代表调用了需要登录的接口，但是并没有登录
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        res.append('Set-Cookie', moduleResponse.cookie)
        res.status(moduleResponse.status).send(moduleResponse.body)
      }
    })
  }

  return app
}

/**
 * Serve the NCM API.
 * @param {NcmApiOptions} options
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function serveNcmApi(options) {
  const port = Number(options.port || process.env.PORT || '3000')
  const host = options.host || process.env.HOST || ''

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        console.log(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = consturctServer(options.moduleDefs)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app
  appExt.server = app.listen(port, host, () => {
    console.log(`server running @ http://${host ? host : 'localhost'}:${port}`)
  })

  return appExt
}

module.exports = {
  serveNcmApi,
  getModulesDefinitions,
}
