const path = require('path')
const fs = require('fs')
const execa = require('execa')
const pathToRegexp = require('path-to-regexp')
const colors = require('colors/safe')
const {setAdjustCssOptions, adjustCss} = require('./tool/adjust-css')
const weuiList = require('./tool/weui-list')
const _ = require('./tool/utils')

const appJsTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/app.tmpl.js'), 'utf8')
const pageBaseJsTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/page.base.tmpl.js'), 'utf8')
const pageJsTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/page.tmpl.js'), 'utf8')
const workerJsTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/worker.tmpl.js'), 'utf8')
const appDisplayWxssTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/app.display.tmpl.wxss'), 'utf8')
const appExtraWxssTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/app.extra.tmpl.wxss'), 'utf8')
const appWxssTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/app.tmpl.wxss'), 'utf8')
const customComponentJsTmpl = fs.readFileSync(path.resolve(__dirname, './tmpl/custom-component.tmpl.js'), 'utf8')
const projectConfigJsonTmpl = require('./tmpl/project.config.tmpl.json')
const packageConfigJsonTmpl = require('./tmpl/package.tmpl.json')

process.env.isMiniprogram = true // 设置环境变量
function isFileExisted(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (err) {
    return false;
  }
}
const globalVars = [
    'self',
    'HTMLElement',
    'Element',
    'Node',
    'localStorage',
    'sessionStorage',
    'navigator',
    'history',
    'location',
    'performance',
    'Image',
    'CustomEvent',
    'Event',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'XMLHttpRequest',
    'Worker',
    'SharedWorker',
]

/**
 * 添加文件
 */
function addFile(bundle, filename, content) {
    //  将code设置成文件
    bundle[fileName] = {
        fileName: filename,
        isAsset: true, // 是否是一个静态资源
        source: content, // 文件内容
        type: 'asset' // 资源类型
      };
}

/**
 * 给 chunk 头尾追加内容
 */
function wrapChunks(bundle, chunks, globalVarsConfig, workerConfig) {
  chunks.forEach(chunk => {
    // 遍历 chunk 中的文件
    chunk.files.forEach(fileName => {
      
      if (workerConfig) {
        if (typeof workerConfig !== 'string') workerConfig = 'common/workers';
        workerConfig = path.relative('common', workerConfig);
      }
      
      const isWorker = workerConfig && new RegExp(`${workerConfig}/(.)*.js$`).test(fileName);
      const isJsFile = /\.js$/.test(fileName);
      
      if (isWorker) {
        // 处理 Web Worker 的 JS 文件
        const headerContent = workerJsTmpl.replace(/[\r\n\t\s]+/ig, ' ');
        bundle[fileName].code = `(function(){${headerContent}${bundle[fileName].code}})()`;
      } else if (isJsFile) {
        // 处理页面 JS 文件
        const headerContent = `module.exports = function(window, document) {var App = function(options) {window.appOptions = options};${globalVars.map(item => `var ${item} = window.${item}`).join(';')};`;
        let customHeaderContent = globalVarsConfig.map(item => `var ${item[0]} = ${item[1] ? item[1] : `window['${item[0]}']`}`).join(';');
        customHeaderContent = customHeaderContent ? `${customHeaderContent};` : '';
        const footerContent = '}';
        
        bundle[fileName].code = `${headerContent}${customHeaderContent}${bundle[fileName].code}${footerContent}`;
      }
    });
  });
}

/**
 * 获取依赖文件路径
 */
function getAssetPath(assetPathPrefix, filePath, assetsSubpackageMap, backwardStr = '../../') {
    if (assetsSubpackageMap[filePath]) assetPathPrefix = '' // 依赖在分包内，不需要补前缀
    return `${assetPathPrefix}${backwardStr}common/${filePath}`
}

function mpVitePlugin(options) {
    const generateConfig = options.generate || {}
    let hasBuiltNpm = false;
    setAdjustCssOptions(options)
  
    return {
      name: 'mp-vite-version',    
      // 类似于 webpack 的 emit hook
      // 主要逻辑在这里，修改一些文件啥的，todo
      async generateBundle(options, bundle) {
        await new Promise((resolve)=>{
            console.log('generateBundle - 在生成的bundle上执行操作');
            // 输出路径
            const outputPath = options.dir || options.file || path.dirname(options.file);

            console.log('Output Path:', outputPath);

            // 获取入口名称
            const entryNames = Object.keys(bundle).filter(fileName => {
                const chunk = bundle[fileName];
                return chunk.isEntry;
            }).map(fileName => fileName.replace(/\.[^.]+$/, ''));

            console.log('Entry Names:', entryNames);
            const appJsEntryName = generateConfig.appEntry || generateConfig.app || '' // 取 app 是为了兼容旧版本的一个 bug
            const globalConfig = options.global || {}
            const pageConfigMap = options.pages || {}
            const subpackagesConfig = generateConfig.subpackages || {}
            const preloadRuleConfig = generateConfig.preloadRule || {}
            const tabBarConfig = generateConfig.tabBar || {}
            const wxCustomComponentConfig = generateConfig.wxCustomComponent || {}
            const wxCustomComponentRoot = wxCustomComponentConfig.root
            const wxCustomComponents = wxCustomComponentConfig.usingComponents || {}
            const useWeui = generateConfig.weui
            const pages = []
            const subpackagesMap = {} // 页面名-分包名
            const assetsMap = {} // 页面名-依赖
            const assetsReverseMap = {} // 依赖-页面名
            const assetsSubpackageMap = {} // 依赖-分包名
            const externalWxssMap = {} // 样式被外部依赖的页面
            const tabBarMap = {}
            let needEmitConfigToSubpackage = false // 是否输出 config.js 到分包内

            // 收集依赖
            for (const entryName of entryNames) {
                const assets = { js: [], css: [] };
                const filePathMap = {};
        
                for (const [fileName, chunkOrAsset] of Object.entries(bundle)) {
                if (!chunkOrAsset.fileName.includes(entryName)) continue;
        
                // 跳过非 css 和 js
                const extMatch = extRegex.exec(fileName);
                if (!extMatch) continue;
        
                // 跳过已记录的
                if (filePathMap[fileName]) continue;
                filePathMap[fileName] = true;
        
                // 记录
                let ext = extMatch[1];
                ext = ext === 'wxss' ? 'css' : ext;
                assets[ext].push(fileName);
        
                // 插入反查表
                assetsReverseMap[fileName] = assetsReverseMap[fileName] || [];
                if (assetsReverseMap[fileName].indexOf(entryName) === -1) {
                    assetsReverseMap[fileName].push(entryName);
                }
        
                // 调整 css 内容
                if (ext === 'css' && chunkOrAsset.type === 'asset') {
                    bundle[fileName].source = adjustCss(chunkOrAsset.source);
                }
                }
                
                assetsMap[entryName] = assets;
            }

            // 处理自定义组件字段
            Object.keys(wxCustomComponents).forEach(key => {
                if (typeof wxCustomComponents[key] === 'string') {
                    wxCustomComponents[key] = {path: wxCustomComponents[key]}
                }
                const {props = [], propsVal = {}, externalWxss} = wxCustomComponents[key]
                wxCustomComponents[key].propsVal = props.reduce((tempObj, item, index) => {
                    tempObj[item] = propsVal[index] || null
                    return tempObj
                }, {})
                if (Array.isArray(externalWxss) && externalWxss.length) externalWxss.forEach(item => externalWxssMap[item] = true) // 标记页面样式需要被外面的自定义组件使用
            })

            // 处理 weui
            if (useWeui) {
                weuiList.forEach(item => {
                    const {
                        name, props = [], propsVal = {}, events = []
                    } = item
                    wxCustomComponents[`mp-${name}`] = {
                        path: `weui-miniprogram/${name}/${name}`,
                        props,
                        propsVal: props.reduce((tempObj, item, index) => {
                            tempObj[item] = propsVal[index] || null
                            return tempObj
                        }, {}),
                        events,
                        isWeui: true,
                    }
                })
            }

            // 处理分包配置
            Object.keys(subpackagesConfig).forEach(packageName => {
                let pages = subpackagesConfig[packageName] || [];
                if (!Array.isArray(pages)) pages = pages.pages;

                pages.forEach(entryName => {
                subpackagesMap[entryName] = packageName;

                const assets = assetsMap[entryName];
                if (assets) {
                    [...assets.js, ...assets.css].forEach(filePath => {
                    const requirePages = assetsReverseMap[filePath] || [];
                    const isWxss = /\.(css|wxss)(\?|$)/.test(filePath);
                    const isExternalWxss = isWxss && (requirePages.some(item => externalWxssMap[item]));

                    if (_.includes(pages, requirePages) && bundle[filePath] && !isExternalWxss) {
                        assetsSubpackageMap[filePath] = packageName;
                        const newFilePath = `../${packageName}/common/${filePath}`;
                        bundle[newFilePath] = bundle[filePath];
                        delete bundle[filePath];
                    }
                    });
                }
                });
            });

            // 剔除 app.js 入口
            const appJsEntryIndex = entryNames.indexOf(appJsEntryName)
            if (appJsEntryIndex >= 0) entryNames.splice(appJsEntryIndex, 1)

            if (generateConfig.app === 'noemit') {
                // generate.app 值为 noemit 且只有分包输出时，将 config.js 输出到分包内
                needEmitConfigToSubpackage = !entryNames.find(entryName => !subpackagesMap[entryName])
            }
            // 处理各个入口页面
            for (const entryName of entryNames) {
                const assets = assetsMap[entryName]
                const pageConfig = pageConfigMap[entryName] = Object.assign({}, globalConfig, pageConfigMap[entryName] || {})
                const loadingView = pageConfig && pageConfig.loadingView
                const loadingViewName = pageConfig && pageConfig.loadingViewName || 'index'
                const addPageScroll = pageConfig && pageConfig.windowScroll
                const pageBackgroundColor = pageConfig && (pageConfig.pageBackgroundColor || pageConfig.backgroundColor) // 兼容原有的 backgroundColor
                const reachBottom = pageConfig && pageConfig.reachBottom
                const reachBottomDistance = pageConfig && pageConfig.reachBottomDistance
                const pullDownRefresh = pageConfig && pageConfig.pullDownRefresh
                const rem = pageConfig && pageConfig.rem
                const pageStyle = pageConfig && pageConfig.pageStyle
                const pageExtraConfig = pageConfig && pageConfig.extra || {}
                const packageName = subpackagesMap[entryName]
                const pageRoute = `${packageName ? packageName + '/' : ''}pages/${entryName}/index`
                const configPathPrefix = packageName && !needEmitConfigToSubpackage ? '../' : ''
                const assetPathPrefix = packageName ? '../' : ''

                // 页面 js
                let pageJsContent = pageJsTmpl
                    .replace('/* CONFIG_PATH */', `${configPathPrefix}../../config`)
                    .replace('/* INIT_FUNCTION */', `function init(window, document) {${assets.js.map(js => 'require(\'' + getAssetPath(assetPathPrefix, js, assetsSubpackageMap) + '\')(window, document)').join(';')}}`)
                let pageScrollFunction = ''
                let reachBottomFunction = ''
                let pullDownRefreshFunction = ''
                if (addPageScroll) {
                    pageScrollFunction = () => 'onPageScroll({ scrollTop }) {if (this.window) {this.window.document.documentElement.$$scrollTop = scrollTop || 0;this.window.$$trigger(\'scroll\');}},'
                }
                if (reachBottom) {
                    reachBottomFunction = () => 'onReachBottom() {if (this.window) {this.window.$$trigger(\'reachbottom\');}},'
                }
                if (pullDownRefresh) {
                    pullDownRefreshFunction = () => 'onPullDownRefresh() {if (this.window) {this.window.$$trigger(\'pulldownrefresh\');}},'
                }
                pageJsContent = pageJsContent
                    .replace('/* PAGE_SCROLL_FUNCTION */', pageScrollFunction)
                    .replace('/* REACH_BOTTOM_FUNCTION */', reachBottomFunction)
                    .replace('/* PULL_DOWN_REFRESH_FUNCTION */', pullDownRefreshFunction)
                addFile(bundle, `../${pageRoute}.js`, pageJsContent)

                // 页面 wxml
                let pageWxmlContent = `<element wx:if="{{pageId}}" class="{{bodyClass}}" style="{{bodyStyle}}" data-private-node-id="e-body" data-private-page-id="{{pageId}}" ${wxCustomComponentRoot || useWeui ? 'generic:custom-component="custom-component"' : ''}></element>`
                if (loadingView) pageWxmlContent = `<loading-view wx:if="{{loading}}" class="miniprogram-loading-view" page-name="${entryName}"></loading-view>` + pageWxmlContent
                if (rem || pageStyle) pageWxmlContent = `<page-meta ${rem ? 'root-font-size="{{rootFontSize}}"' : ''} ${pageStyle ? 'page-style="{{pageStyle}}"' : ''}></page-meta>` + pageWxmlContent
                addFile(bundle, `../${pageRoute}.wxml`, pageWxmlContent)

                // 页面 wxss
                let pageWxssContent = assets.css.map(css => `@import "${getAssetPath(assetPathPrefix, css, assetsSubpackageMap)}";`).join('\n')
                if (loadingView) pageWxssContent = '.miniprogram-loading-view{position:fixed;top:0;left:0;bottom:0;right:0;z-index:0;}.miniprogram-root{display:block;position:relative;z-index:1;background:#fff;}' + pageWxssContent
                if (pageBackgroundColor) pageWxssContent = `page{background-color:${pageBackgroundColor};}\n` + pageWxssContent
                addFile(bundle, `../${pageRoute}.wxss`, adjustCss(pageWxssContent))

                // 页面 json
                const pageJson = {
                    ...pageExtraConfig,
                    enablePullDownRefresh: !!pullDownRefresh,
                    usingComponents: {
                        element: 'miniprogram-element',
                    },
                }
                if (loadingView) pageJson.usingComponents['loading-view'] = `${assetPathPrefix}../../loading-view/${loadingViewName}`
                if (wxCustomComponentRoot || useWeui) pageJson.usingComponents['custom-component'] = `${assetPathPrefix}../../custom-component/index`
                if (reachBottom && typeof reachBottomDistance === 'number') pageJson.onReachBottomDistance = reachBottomDistance
                const pageJsonContent = JSON.stringify(pageJson, null, '\t')
                addFile(bundle, `../${pageRoute}.json`, pageJsonContent)

                // 页面共用 base.js
                addFile(bundle, `../${packageName ? packageName + '/' : ''}pages/base.js`, pageBaseJsTmpl)

                // 记录页面路径
                if (!packageName) pages.push(pageRoute)

                // 拷贝 loadingView 目录到项目根目录下
                if (loadingView) {
                    bundle.contextDependencies.add(loadingView) // 支持 watch
                    _.copyDir(loadingView, path.resolve(outputPath, '../loading-view'))
                }
            }

            // 追加 webview 页面
            if (options.redirect && (options.redirect.notFound === 'webview' || options.redirect.accessDenied === 'webview')) {
                addFile(bundle, '../pages/webview/index.js', 'Page({data:{url:\'\'},onLoad: function(query){this.setData({url:decodeURIComponent(query.url)})}})')
                addFile(bundle, '../pages/webview/index.wxml', '<web-view src="{{url}}"></web-view>')
                addFile(bundle, '../pages/webview/index.wxss', '')
                addFile(bundle, '../pages/webview/index.json', '{"usingComponents":{}}')
                pages.push('pages/webview/index')
            }

            const appConfig = generateConfig.app || 'default'
            const isEmitApp = appConfig !== 'noemit'
            const isEmitProjectConfig = appConfig !== 'noconfig'
            let workersDir = 'common/workers'

            // tabbar
            let tabBar
            if (tabBarConfig.list && tabBarConfig.list.length) {
                tabBar = Object.assign({}, tabBarConfig)
                tabBar.list = tabBarConfig.list.map(item => {
                    const iconPathName = item.iconPath ? _.md5File(item.iconPath) + path.extname(item.iconPath) : ''
                    if (iconPathName) _.copyFile(item.iconPath, path.resolve(outputPath, `../images/${iconPathName}`))
                    const selectedIconPathName = item.selectedIconPath ? _.md5File(item.selectedIconPath) + path.extname(item.selectedIconPath) : ''
                    if (selectedIconPathName) _.copyFile(item.selectedIconPath, path.resolve(outputPath, `../images/${selectedIconPathName}`))
                    tabBarMap[`/pages/${item.pageName}/index`] = true

                    const tabBarItem = {
                        pagePath: `pages/${item.pageName}/index`,
                        text: item.text,
                    }
                    if (iconPathName) tabBarItem.iconPath = `./images/${iconPathName}`
                    if (selectedIconPathName) tabBarItem.selectedIconPath = `./images/${selectedIconPathName}`

                    return tabBarItem
                })

                if (tabBar.custom) {
                    // 自定义 tabBar
                    const customTabBarDir = tabBar.custom
                    tabBar.custom = true
                    // TODO: 支持自定义tabBar 进行热更新，之后支持
                    // compilation.contextDependencies.add(customTabBarDir) // 支持 watch
                    _.copyDir(customTabBarDir, path.resolve(outputPath, '../custom-tab-bar'))
                }
            }

            // worker
            if (generateConfig.worker) {
                workersDir = typeof generateConfig.worker === 'string' ? generateConfig.worker : workersDir
            }

            if (isEmitApp) {
                // app js
                const appAssets = assetsMap[appJsEntryName] || {js: [], css: []}
                const appJsInject = generateConfig.appEntryInject || ''
                const appJsContent = appJsTmpl
                    .replace('/* INIT_FUNCTION */', `var fakeWindow = {};var fakeDocument = {};(function(window, document) {${appJsInject}})(fakeWindow, fakeDocument);${appAssets.js.map(js => 'require(\'' + getAssetPath('', js, assetsSubpackageMap, '') + '\')(fakeWindow, fakeDocument);').join('')}var appConfig = fakeWindow.appOptions || {};`)
                addFile(bundle, '../app.js', appJsContent)

                // app wxss
                const appWxssConfig = generateConfig.appWxss || 'default'
                let appWxssContent = appWxssConfig === 'none' ? '' : appWxssConfig === 'display' ? appDisplayWxssTmpl : appWxssTmpl
                if (appAssets.css.length) {
                    appWxssContent += `\n${appAssets.css.map(css => `@import "${getAssetPath('', css, assetsSubpackageMap, '')}";`).join('\n')}`
                }
                appWxssContent = adjustCss(appWxssContent)
                if (appWxssConfig !== 'none' && appWxssConfig !== 'display') {
                    appWxssContent += '\n' + appExtraWxssTmpl
                }
                addFile(bundle, '../app.wxss', appWxssContent)

                // app json
                const subpackages = []
                const preloadRule = {}
                Object.keys(subpackagesConfig).forEach(packageName => {
                    let pages = subpackagesConfig[packageName] || []
                    let extraOptions = {}
                    if (!Array.isArray(pages)) {
                        extraOptions = Object.assign(extraOptions, pages)
                        pages = pages.pages
                        delete extraOptions.pages
                    }

                    subpackages.push({
                        name: packageName,
                        root: packageName,
                        pages: pages.map(entryName => `pages/${entryName}/index`),
                        ...extraOptions,
                    })
                })
                Object.keys(preloadRuleConfig).forEach(entryName => {
                    const packageName = subpackagesMap[entryName]
                    const pageRoute = `${packageName ? packageName + '/' : ''}pages/${entryName}/index`
                    preloadRule[pageRoute] = preloadRuleConfig[entryName]
                })
                const userAppJson = options.appExtraConfig || {}
                const appJson = {
                    pages,
                    window: options.app || {},
                    subpackages,
                    preloadRule,
                    ...userAppJson,
                }

                if (tabBar) appJson.tabBar = tabBar
                if (generateConfig.worker) appJson.workers = workersDir

                if (useWeui) {
                    // 使用 weui 扩展库
                    appJson.useExtendedLib = appJson.useExtendedLib || {}
                    if (appJson.useExtendedLib.weui === undefined) appJson.useExtendedLib.weui = true
                }
                const appJsonContent = JSON.stringify(appJson, null, '\t')
                addFile(bundle, '../app.json', appJsonContent)

                if (isEmitProjectConfig) {
                    // project.config.json
                    const userProjectConfigJson = options.projectConfig || {}
                    // 这里需要深拷贝，不然数组相同引用指向一直 push
                    const projectConfigJson = JSON.parse(JSON.stringify(projectConfigJsonTmpl))
                    const projectConfigJsonContent = JSON.stringify(_.merge(projectConfigJson, userProjectConfigJson), null, '\t')
                    const projectConfigPath = generateConfig.projectConfig ? path.join(path.relative(outputPath, generateConfig.projectConfig), './project.config.json') : '../project.config.json'
                    addFile(bundle, projectConfigPath, projectConfigJsonContent)
                }

                // sitemap.json
                const userSitemapConfigJson = options.sitemapConfig
                if (userSitemapConfigJson) {
                    const sitemapConfigJsonContent = JSON.stringify(userSitemapConfigJson, null, '\t')
                    addFile(bundle, '../sitemap.json', sitemapConfigJsonContent)
                }
            }

            // config js
            const router = {}
            if (options.router) {
                // 处理 router
                Object.keys(options.router).forEach(key => {
                    const pathObjList = []
                    let pathList = options.router[key]
                    pathList = Array.isArray(pathList) ? pathList : [pathList]

                    for (const pathItem of pathList) {
                        // 将每个 route 转成正则并进行序列化
                        if (!pathItem || typeof pathItem !== 'string') continue

                        const keys = []
                        const regexp = pathToRegexp(pathItem, keys)
                        const pattern = regexp.valueOf()

                        pathObjList.push({
                            regexp: pattern.source,
                            options: `${pattern.global ? 'g' : ''}${pattern.ignoreCase ? 'i' : ''}${pattern.multiline ? 'm' : ''}`,
                        })
                    }
                    router[key] = pathObjList
                })
            }
            const configJsContent = 'module.exports = ' + JSON.stringify({
                origin: options.origin || 'https://miniprogram.default',
                entry: options.entry || '/',
                router,
                generate: {worker: workersDir},
                runtime: Object.assign({
                    subpackagesMap,
                    tabBarMap,
                    usingComponents: wxCustomComponents,
                }, options.runtime || {}),
                pages: pageConfigMap,
                redirect: options.redirect || {},
                optimization: options.optimization || {},
            }, null, '\t')
            if (needEmitConfigToSubpackage) {
                Object.keys(subpackagesConfig).forEach(packageName => {
                    addFile(bundle, `../${packageName}/config.js`, configJsContent)
                })
            } else {
                addFile(bundle, '../config.js', configJsContent)
            }

            // package.json
            if (typeof options.packageConfigOverride === 'object') {
                // 覆盖模式
                const userPackageConfigJson = options.packageConfigOverride || {}
                const packageConfigJsonContent = JSON.stringify(userPackageConfigJson, null, '\t')
                addFile(bundle, '../package.json', packageConfigJsonContent)
            } else {
                // 合并模式
                const userPackageConfigJson = options.packageConfig || {}
                const packageConfigJson = Object.assign({}, packageConfigJsonTmpl)
                packageConfigJson.dependencies = Object.assign({}, packageConfigJson.dependencies)
                if (generateConfig.renderVersion) packageConfigJson.dependencies['miniprogram-render'] = generateConfig.renderVersion
                if (generateConfig.elementVersion) packageConfigJson.dependencies['miniprogram-element'] = generateConfig.elementVersion
                const packageConfigJsonContent = JSON.stringify(_.merge(packageConfigJson, userPackageConfigJson), null, '\t')
                addFile(bundle, '../package.json', packageConfigJsonContent)
            }

            // node_modules
            addFile(bundle, '../node_modules/.miniprogram', '')

            // 自定义组件
            if (wxCustomComponentRoot || useWeui) {
                const realUsingComponents = {}
                const names = Object.keys(wxCustomComponents)

                if (wxCustomComponentRoot) {
                    // 包含第三方自定义组件
                    // TODO: 自定义组件支持watch 热更新
                    // compilation.contextDependencies.add(wxCustomComponentRoot) // 支持 watch
                    _.copyDir(wxCustomComponentRoot, path.resolve(outputPath, '../custom-component/components'))

                    // 转换路径
                    names.forEach(key => {
                        if (!wxCustomComponents[key].isWeui) realUsingComponents[key] = `components/${wxCustomComponents[key].path}`
                    })
                }

                if (useWeui) {
                    // 包含 weui
                    names.forEach(key => {
                        if (wxCustomComponents[key].isWeui) realUsingComponents[key] = wxCustomComponents[key].path
                    })
                }

                // custom-component/index.js
                addFile(bundle, '../custom-component/index.js', customComponentJsTmpl)

                // custom-component/index.wxml
                addFile(bundle, '../custom-component/index.wxml', names.map((key, index) => {
                    const {props = [], events = []} = wxCustomComponents[key]
                    return `<${key} wx:${index === 0 ? 'if' : 'elif'}="{{kboneCustomComponentName === '${key}'}}" id="{{id}}" class="{{className}}" style="{{style}}" ${props.map(name => name + '="{{' + (name.replace(/-([a-zA-Z])/g, (all, $1) => $1.toUpperCase())) + '}}"').join(' ')} ${events.map(name => 'bind:' + name + '="on' + name + '"').join(' ')}><block wx:if="{{hasSlots}}"><element wx:for="{{slots}}" wx:key="nodeId" id="{{item.id}}" class="{{item.className}}" style="{{item.style}}" slot="{{item.slot}}" data-private-node-id="{{item.nodeId}}" data-private-page-id="{{item.pageId}}" generic:custom-component="custom-component"></element></block><slot/></${key}>`
                }).join('\n'))

                // custom-component/index.wxss
                addFile(bundle, '../custom-component/index.wxss', names.map(key => {
                    const {externalWxss} = wxCustomComponents[key]
                    if (externalWxss && typeof externalWxss === 'string') {
                        return externalWxss
                    } else if (Array.isArray(externalWxss) && externalWxss.length) {
                        return externalWxss.map(entryName => {
                            const assets = assetsMap[entryName]
                            return assets.css.map(css => `@import "${getAssetPath('', css, assetsSubpackageMap, '../')}";`).join('\n')
                        }).join('\n\n')
                    } else {
                        return ''
                    }
                }).join('\n'))

                // custom-component/index.json
                realUsingComponents['custom-component'] = './index'
                realUsingComponents.element = 'miniprogram-element'
                addFile(bundle, '../custom-component/index.json', JSON.stringify({
                    component: true,
                    usingComponents: realUsingComponents,
                }, null, '\t'))
            }



            const globalVarsConfig = generateConfig.globalVars || [];
            const workerConfig = generateConfig.worker;

            const chunks = Object.entries(bundle).filter(([key, value]) => value.type === 'chunk');

            if (afterOptimizations) {
              // 在构建后处理 chunks
              wrapChunks(bundle, chunks.map(([_, value]) => value), globalVarsConfig, workerConfig);
            } else {
              // 在构建期间处理 chunks
              chunks.forEach(([fileName, chunk]) => {
                bundle[fileName].code = wrapChunks(bundle, [chunk], globalVarsConfig, workerConfig);
              });
            }


            resolve();
        })
      },


      renderChunk(code, chunk, options) {
        if (!afterOptimizations) {
          const globalVarsConfig = generateConfig.globalVars || [];
          const workerConfig = generateConfig.worker;

          // 直接在渲染块时处理代码
          code = `/** Global Vars **/\n${globalVarsConfig.join('\n')}\n${code}\n/** Worker Config **/\n${workerConfig}`;
          return { code, map: null }; // 返回修饰后的代码
        }
        return null;
      },


      async closeBundle() {
        // 处理自动安装小程序依赖
        const autoBuildNpm = generateConfig.autoBuildNpm || false;
        const distDir = path.resolve(process.cwd(), 'dist'); // 假设dist目录是'./dist'
  
        hasBuiltNpm = isFileExisted(path.resolve(distDir, './node_modules/miniprogram-element/package.json')) &&
                      isFileExisted(path.resolve(distDir, './node_modules/miniprogram-render/package.json'));
  
        if (hasBuiltNpm || !autoBuildNpm) {
          if (hasBuiltNpm) console.log(colors.bold('\ndependencies have been built\n'));
          return;
        }
  
        const build = () => {
          const elementDist = path.resolve(distDir, './node_modules/miniprogram-element/dist');
          if (isFileExisted(elementDist)) {
            fse.copySync(elementDist, path.resolve(distDir, './miniprogram_npm/miniprogram-element'));
          } else {
            fse.copySync(path.resolve(distDir, './node_modules/miniprogram-element/src'), path.resolve(distDir, './miniprogram_npm/miniprogram-element'));
          }
  
          const renderDist = path.resolve(distDir, './node_modules/miniprogram-render/dist');
          if (isFileExisted(renderDist)) {
            fse.copySync(renderDist, path.resolve(distDir, './miniprogram_npm/miniprogram-render'));
          } else {
            fse.copySync(path.resolve(distDir, './node_modules/miniprogram-render/src'), path.resolve(distDir, './miniprogram_npm/miniprogram-render'));
          }
          console.log(colors.bold('\nDependencies built successfully\n'));
        };
  
        console.log(colors.bold('\nstart building dependencies...\n'));
  
        const command = autoBuildNpm === 'yarn' ? 'yarn' : 'npm';
        try {
          const { exitCode } = await execa(command, ['install', '--production'], { cwd: distDir });
          if (exitCode === 0) {
            console.log(colors.bold(`\nbuilt dependencies ${colors.green('successfully')}\n`));
            build();
          } else {
            console.log(colors.bold(`\nbuilt dependencies ${colors.red('failed')}, please enter "${colors.yellow(distDir)}" and run install manually\n`));
          }
        } catch (err) {
          console.log(colors.bold(`\nbuilt dependencies ${colors.red('failed')}, please enter "${colors.yellow(distDir)}" and run install manually\n`));
        }
      },
  
    };
  }

  export default mpVitePlugin;
