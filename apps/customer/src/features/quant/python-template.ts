/**
 * The sandbox's Python starter (J-algo-dev-16 #1): the same calls as the JavaScript runtime, one limit buy below the TEST
 * mark that fills when the price reaches it, and one order of quantity zero the sandbox rejects as a rejected event.
 * `sdks/python/intafaced_quant` hands out the same text as `strategy_template()`.
 */
export const PYTHON_TEMPLATE = `a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc")
z = oms.limitBuy("BTC-USD", "0", "49990", "gtc")
print(z.status)
print(z.reason)`;
