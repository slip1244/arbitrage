const crypto = require("crypto")
const fetch = require("node-fetch")
const ACCESS = process.env.ACCESS
const SECRET = process.env.SECRET
const AUTH = process.env.AUTH
const TRADE_QUANTITY = 0.00011
const CURRENCY_MAIN = "BTC"
const MAX_PATH_LENGTH = 4
const ARMED = true
const NOCONF = false
const intervalDelay = 1500
const UNLIMITED = false
const THRESHOLD = 1.001
const LOW_CUTOFF = 0.00025
const WS = require('ws');
const { update, last, size } = require('lodash')
const { exec } = require('child_process')
const { parse } = require("path")
const { PerformanceObserver, performance } = require('perf_hooks');
const order = require("@alpacahq/alpaca-trade-api/lib/resources/order")
const REST_URL = "https://api.altilly.com/api"
const WS_URL = "wss://wsapi.altilly.com:2096"
const Discord = require("discord.js")
const Client = new Discord.Client()
Client.login(process.env.TOKEN)
Client.on("ready", async () => {
  console.log("Bot Logged In")
})
const NONCE = Math.random().toString()
const SIGNATURE = crypto.createHmac("sha256", SECRET).update(NONCE).digest("hex")
let mktGraph = {}
let mktMappings = {}
let wsQueries = []
const orders = {}
let lastBalance
let pauseUpdating = false
let pauseExecuting = false
executing = false
process.env.UV_THREADPOOL_SIZE = 512;

Client.on("message", (msg) => {
  if (msg.author.id == "379088700518301696" && msg.content == "!bal") {
    sendDiscord(lastBalance)
  }
})

async function sendDiscord(text) {
  return new Promise(async r => {
    const guild = await Client.guilds.cache.get("749092790264135741")
    const user = await guild.members.fetch("379088700518301696")
    await user.send(text)
    r()
  })
}

const ws = new WS(WS_URL, {
  perMessageDeflate: false
});

ws.on('open', async () => {
  console.log("\u001b[32mConnected\u001b[0m")
  await wsApiQuery("login", {algo: "HS256", pKey: ACCESS, nonce: NONCE, signature: SIGNATURE})
  console.log("\u001b[36mLogged In\u001b[0m")
  const symbols = await wsApiQuery("getSymbols")
  for (let market of symbols) {
    mktMappings[market.id] = {base: market.baseCurrency, quote: market.quoteCurrency, precision: market.quantityIncrement}
    wsApiQuery("subscribeOrderbook", {symbol: market.id})
  }
  lastBalance = await getBalance(CURRENCY_MAIN)
  setTimeout(arbitrageLoop, 2000)
  setTimeout(refreshGraph, 600000)
});

ws.on('close', async (reason) => {
  console.log(reason)
  console.log("\u001b[31mDisconnected\u001b[0m")
  await sendDiscord("WS CLOSED")
  process.exit()
});

ws.on('error', (reason) => {
  console.log(reason)
  console.log("\u001b[31mError\u001b[0m")
});

ws.on("message", msg => {
  let parsed = JSON.parse(msg)
  if (wsQueries[parsed.id]) {
    wsQueries[parsed.id].resolve(parsed.result)
  }
  if (!pauseUpdating) {
    if (parsed.method == "snapshotOrderbook") {
      snapshotMktGraph(parsed.params)
    } else if (parsed.method == "updateOrderbook") {
      updateMktGraph(parsed.params)
    }
  }
})

function wsApiQuery(method, params) {
  const queryPromise = new Promise((resolve, reject) => {
    let id = wsQueries.length
    wsQueries[id] = { 
      resolve: resolve,
      reject: reject
    }
    ws.send(JSON.stringify({method: method, params: params, id: id.toString()}))
  })
  return queryPromise
}

function restApiQuery(path, method, body=null) {
  return fetch(REST_URL + path, {
    method: method,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH
    },
    body: (body != null ? JSON.stringify(body) : null)
  }).then(resp => resp.json()).catch(e => console.log(e.stack))
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

Number.prototype.toIncrement = function (precision) {
  return this.valueOf() - this.valueOf() % precision
}

const arrCompare = (a1, a2) => a1.length == a2.length && a1.every((v,i) => v === a2[i]);

async function arbitrageLoop() {
  console.log("\033[38;2;255;0;255mStarted\u001b[0m")
  let paths = []
  let lastPath = []
  for (let i = 2; i <= MAX_PATH_LENGTH; i++) {
    paths = paths.concat(getAllPaths(CURRENCY_MAIN, i))
  }
  while (true) {
    if (!pauseExecuting) {
      const bestPath = getBestPath(paths, TRADE_QUANTITY)
      if (bestPath && bestPath.r >= THRESHOLD || UNLIMITED) {
        console.log(bestPath.p)
        const opp = ((bestPath.r - 1) * 100).toFixed(3)
        console.log("OPP: \u001b[32;4;1m" + opp + "%\u001b[0m")
        if (NOCONF || arrCompare(lastPath, bestPath.p)) {
          if (ARMED) {
            let result = await executePath(bestPath)
            const profit = ((((result - lastBalance) / TRADE_QUANTITY) * 100)).toFixed(3)
            lastBalance = result
            console.log("EXEC: \u001b[32;4;1m" + profit + "%\u001b[0m")
            await sendDiscord("EXEC: Expected " + opp + "% | Actual " + profit + "%")
          }
        } else {
          console.log("CONF")
          lastPath = bestPath.p
        }
        console.log("\033[38;2;255;0;255m--------------\u001b[0m")
      } else {
        lastPath = []
      }
      await sleep(intervalDelay)
    }
  }
}

async function executePath(arbitragePath) {
  console.log(arbitragePath)
  executing = true
  return new Promise(async (resolve, reject) => {
    if (lastBalance < LOW_CUTOFF) {
      await sendDiscord("BAL TOO LOW")
      process.exit()
    }
    console.log("Initial " + CURRENCY_MAIN + " Balance: " + lastBalance)
    const path = arbitragePath.p
    let from = path[0]
    let lastQuantity = TRADE_QUANTITY
    const len = path.length
    for (let i = 1; i < len; i++) {
      const to = path[i]
      let side = mktGraph[from][to].s
      let increment = mktGraph[from][to].p
      const factor = getFactor(from, to, side ? lastQuantity : lastQuantity * 0.9988)
      if (!factor) {
        executing = false
        await sendDiscord("STALE TRADE")
        process.exit()
      }
      const orderAmount = (side ? (lastQuantity).toIncrement(increment) : (((lastQuantity * 0.9988) / factor.f).toIncrement(increment)))
      console.log("Attempting to " + (side ? "sell" : "buy") + " " + orderAmount + " of " + (side ? from : to) + " at " + factor.f)
      let orderResult = await makeOrder((side ? "market" : "limit"), {
        market: side ? from + to : to + from,
        side: (side ? "sell" : "buy"),
        quantity: orderAmount,
        price: factor.p
      })
      if (orderResult.error) {
        console.log(orderResult.error)
        await sendDiscord("ORDER ERROR")
        process.exit()
      } else {
        console.log((side ? "Sold " : "Bought ") + orderResult.quantity + " " + (side ? from : to) + " at " + orderResult.price)
      }
      let Dtimeout = setTimeout(async () => {
        await sendDiscord("ORDER NOT FILLED - TIMED OUT")
        process.exit()
      }, 20000)
      if (to != CURRENCY_MAIN) {
        lastQuantity = 0
        while (lastQuantity < (side ? orderAmount * factor.f : orderAmount) / 1.5) {
          lastQuantity = await getBalance(to)
        }
        console.log("New " + to + " Balance: " + lastQuantity)
        from = to
      }
      clearTimeout(Dtimeout)
    }
    let final = 0
    await sleep(1000)
    final = await getBalance(CURRENCY_MAIN)
    console.log("New " + CURRENCY_MAIN + " Balance: " + final)
    executing = false
    resolve(final)
  })
}

async function getBalance(currency) {
  const balanceData = await wsApiQuery("getTradingBalance")
  for (let balance of balanceData) {
    if (balance.currency === currency) {
      return +balance.available
    }
  }
  return 0
}

async function makeOrder(type, opt) {
  const options = {
    symbol: opt.market,
    side: opt.side,
    type: type,
    quantity: opt.quantity,
    timeInForce: "GTC",
    clientOrderId: Date.now().toString(36) + Math.random().toString(36).substring(2, 15)
  }
  if (type == "limit") options.price = opt.price
  return await restApiQuery("/order", "POST", options)
}

function snapshotMktGraph(mkt) {
  const [base, quote] = [mktMappings[mkt.symbol].base, mktMappings[mkt.symbol].quote]
  if (!mktGraph[base]) {
    mktGraph[base] = {}
  }
  mktGraph[base][quote] = {o: mkt.bid, s: true, p: mktMappings[mkt.symbol].precision}
  if (!mktGraph[quote]) {
    mktGraph[quote] = {}
  }
  mktGraph[quote][base] = {o: mkt.ask, s: false, p: mktMappings[mkt.symbol].precision}
}

function updateMktGraph(mkt) {
  const [base, quote] = [mktMappings[mkt.symbol].base, mktMappings[mkt.symbol].quote]
  for (let pricePoint of mkt.bid) {
    let present = false
    const len = mktGraph[base][quote].o.length
    for (let i = 0; i < len; i++) {
      if (pricePoint.price > mktGraph[base][quote].o[i].price) {
        mktGraph[base][quote].o.splice(i, 0, pricePoint)
        present = true
        break
      } else if (pricePoint.price == mktGraph[base][quote].o[i].price) {
        if (pricePoint.size == 0) {
          mktGraph[base][quote].o.splice(i,1)
        } else {
          mktGraph[base][quote].o[i] = pricePoint
        }
        present = true
        break
      }
    }
    if (!present) {
      mktGraph[base][quote].o.push(pricePoint)
    }
  }

  for (let pricePoint of mkt.ask) {
    let present = false
    const len = mktGraph[quote][base].o.length
    for (let i = 0; i < len; i++) {
      if (pricePoint.price < mktGraph[quote][base].o[i].price) {
        mktGraph[quote][base].o.splice(i, 0, pricePoint)
        present = true
        break 
      } else if (pricePoint.price == mktGraph[quote][base].o[i].price) {
        if (pricePoint.size == 0) {
          mktGraph[quote][base].o.splice(i,1)
        } else {
          mktGraph[quote][base].o[i] = pricePoint
        }
        present = true
        break
      }
    }
    if (!present) {
      mktGraph[quote][base].o.push(pricePoint)
    }
  }
}

function getAllPaths(starter, stops) {
  let paths = [[starter]]
  for (let i = 1; i <= stops; i++) {
    let newPaths = []
    for (const path of paths) {
      for (let ticker in mktGraph[path[path.length-1]]) {
        newPaths.push([...path, ticker])
      }
    }
    paths = newPaths
  }
  return paths.filter(path => (path[0] === path[path.length-1]))
}

function getBestPath(paths, amount) {
  paths = paths.map(path => calculatePath(path, amount))
  let bestPath = paths[0]
  for (let path of paths) {
    if (!bestPath || (path && path.r >= bestPath.r)) {
      bestPath = path
    }
  }
  return bestPath
}

function calculatePath(path, amount) {
  let currentCurrency = amount
  let lastTicker = path[0]
  const len = path.length
  for (let i = 1; i < len; i++) {
    const factor = getFactor(lastTicker, path[i], currentCurrency)
    if (factor) {
      if (mktGraph[lastTicker][path[i]].s) {
        currentCurrency *= factor.f
      } else {
        currentCurrency /= factor.f
      }
    } else {
      return null
    }
    currentCurrency *= 0.9988
    lastTicker = path[i]
  }
  return {p: path, r: currentCurrency / amount}
}

function getFactor(from, to, amount) {
  const orders = mktGraph[from][to].o
  if (orders.length === 0) return null
  const type = mktGraph[from][to].s
  let filledSum = 0
  let factor = 0
  let lastOrderPrice = 0;
  let level = 0
  const len = orders.length
  for (let i = 0; i < len; i++) {
    lastOrderPrice = orders[i].price
    let orderSize = (type ? +orders[i].size : +orders[i].size * lastOrderPrice)
    level = i
    if (filledSum + orderSize > amount) {
      factor += lastOrderPrice * ((amount - filledSum) / amount)
      filledSum += orderSize
      break
    } else {
      factor += lastOrderPrice * (orderSize / amount)
      filledSum += orderSize
    }
  }
  if ((!type && level > 0) || filledSum < amount) {
    return null
  } else {
    return {f: factor, p: lastOrderPrice}
  }
}

async function refreshGraph() {
  console.log("REFRESHING - EXECUTION RESTARTING")
  while (executing) {
    await sleep(100)
  }
  process.exit()
}