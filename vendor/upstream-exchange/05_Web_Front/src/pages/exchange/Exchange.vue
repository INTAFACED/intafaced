<template>
  <div class="ix-terminal" :class="{ 'is-perp': isPerpKind }" @keydown="onDeskKeydown">
    <!-- A-UI-1 / B7+: / markets · Esc clear · B/S buy-sell ticket · T ticket · Enter submit · X cancel last -->
    <a class="ix-skip-link" href="#ix-ticket">{{ $t("exchange.residual.skipToTicket") }}</a>
    <!-- A-UI-A11Y / B10: LiveAnnouncer-style region (assertive for ticket errors) -->
    <div class="ix-sr-only" aria-live="assertive" aria-atomic="true">{{ liveAnnounce }}</div>
    <!-- ══ pair header ══════════════════════════════════════════════════ -->
    <header class="ix-head">
      <router-link to="/" class="ix-desk-brand" aria-label="INTAFACED home">INTAFACED</router-link>
      <div class="ix-head-pair">
        <button
          type="button"
          class="ix-star"
          :class="{ 'is-on': currentCoinIsFavor }"
          @click="toggleFavorite"
          :title="currentCoinIsFavor ? $t('exchange.terminal.favoriteRemove') : $t('exchange.terminal.favoriteAdd')"
          :aria-label="currentCoinIsFavor ? $t('exchange.terminal.favoriteRemove') : $t('exchange.terminal.favoriteAdd')"
          :aria-pressed="currentCoinIsFavor ? 'true' : 'false'"
        >
          <Icon :type="currentCoinIsFavor ? 'ios-star' : 'ios-star-outline'" size="18" />
        </button>
        <button
          ref="marketDrawerTrigger"
          type="button"
          class="ix-pair ix-pair-switch"
          :aria-expanded="marketsOpen ? 'true' : 'false'"
          aria-controls="ix-market-drawer"
          @click="toggleMarkets"
        >
          <span class="ix-pair-coin">{{ currentCoin.coin || '—' }}</span>
          <span class="ix-pair-base">/{{ currentCoin.base || '—' }}</span>
          <span class="ix-pair-caret" aria-hidden="true">⌄</span>
        </button>
        <Poptip
          v-if="coinInfo.information"
          trigger="hover"
          :title="coinInfo.name"
          placement="bottom-start"
          word-wrap
          width="320"
        >
          <Icon type="md-information-circle" class="ix-info-icon" size="15" />
          <div slot="content">
            <p class="ix-coin-info">{{ coinInfo.information }}</p>
            <p class="ix-coin-link" v-if="coinInfo.infolink">
              <a :href="coinInfo.infolink" target="_blank" rel="noopener">{{ $t("exchange.terminal.moreDetail") }}</a>
            </p>
          </div>
        </Poptip>
      </div>

      <div class="ix-head-last">
        <span class="ix-last" :class="trendClass">{{ lastPriceLabel }}</span>
        <span class="ix-last-alt" v-if="fiatValue">&asymp; {{ fiatValue }} CNY</span>
      </div>

      <dl class="ix-stat">
        <dt>{{ $t("exchange.terminal.change24h") }}</dt>
        <dd :class="trendClass">{{ marketStat(currentCoin.rose) }}</dd>
      </dl>
      <dl class="ix-stat">
        <dt>{{ $t("exchange.terminal.high24h") }}</dt>
        <dd>{{ marketNum(currentCoin.high, baseCoinScale) }}</dd>
      </dl>
      <dl class="ix-stat">
        <dt>{{ $t("exchange.terminal.low24h") }}</dt>
        <dd>{{ marketNum(currentCoin.low, baseCoinScale) }}</dd>
      </dl>
      <dl class="ix-stat ix-stat-wide">
        <dt>{{ $t("exchange.terminal.volume24h") }}</dt>
        <dd>{{ marketNum(currentCoin.volume, 2) }} <em v-if="feedLive || positiveDecimal(currentCoin.volume)">{{ currentCoin.coin }}</em></dd>
      </dl>
      <dl class="ix-stat" v-if="currentCoin.expiryDatetime">
        <dt>{{ $t('exchange.hlplus.expiry') }}</dt>
        <dd>{{ currentCoin.expiryDatetime }}</dd>
      </dl>
      <!-- Last / 24h high-low-volume are REST ticker snapshots, not the live depth
           stream. Badge "Depth live" is separate — do not let 24h labels imply a
           rolling live window without provenance. -->
      <div class="ix-head-snapshot" :title="$t('intafaced.trade.snapshotSource')">
        {{ $t('intafaced.trade.snapshotSource') }}
      </div>

      <!-- A-UI-SUB: identity catalogue switcher. No balances. No order routing. -->
      <div class="ix-head-sub">
        <SubAccountSelector @change="onSubAccountChange" />
      </div>

      <div
        class="ix-head-status"
        :title="channelStatus.title"
        role="group"
        aria-label="Session channels"
      >
        <span class="ix-sr-only">{{ channelStatus.badge }}</span>
        <span
          v-for="chip in channelStatus.chips"
          :key="chip.id"
          class="ix-channel-chip"
          :class="'is-' + chip.state"
          :data-channel="chip.id"
        >{{ chip.label }}</span>
      </div>

      <nav class="ix-desk-plane" :aria-label="$t('header.planeLabel')">
        <router-link to="/exchange" class="is-active">{{ $t('exchange.residual.planeCexShort') }}</router-link>
        <router-link to="/dex">{{ $t('exchange.residual.planeDexShort') }}</router-link>
      </nav>
      <router-link :to="isLogin ? '/platform' : '/login'" class="ix-desk-account">
        {{ isLogin ? $t('header.usercenter') : $t('common.login') }}
      </router-link>
    </header>

    <div class="ix-desk-banner" role="status">
      <span class="ix-desk-banner-kicker">{{
        channelStatus.sessionLive ? 'Session live' : 'Session not live'
      }}</span>
      <span
        v-if="deskLock && (deskLock.key === 'order_entry_locked' || deskLock.key === 'recovery_locked')"
        class="ix-desk-banner-lock"
      >{{ deskLock.message }}</span>
      <button
        type="button"
        class="ix-lock-toggle"
        :aria-pressed="orderEntryLocked ? 'true' : 'false'"
        @click="toggleOrderEntryLock"
      >
        {{ orderEntryLocked ? 'Unlock order entry' : 'Lock order entry' }}
      </button>
    </div>

    <div v-if="isPerpKind" class="ix-perp-strip" :title="futuresTickerMessage">
      <dl>
        <dt>{{ $t('exchange.hlplus.lastPrice') }}</dt>
        <dd>{{ lastPriceLabel }}</dd>
      </dl>
      <dl>
        <dt>{{ $t('exchange.hlplus.oracleIndexPrice') }}</dt>
        <dd>—</dd>
      </dl>
      <dl>
        <dt>{{ $t('exchange.hlplus.markPrice') }}</dt>
        <dd>{{ futuresTickerValue(futuresTicker.markPrice) }}</dd>
        <small v-if="futuresTicker.markSource">{{ futuresMarkSourceLabel }}</small>
      </dl>
      <dl>
        <dt>{{ $t('exchange.hlplus.fundingRate') }}</dt>
        <dd>{{ fundingRateLabel }}</dd>
      </dl>
      <dl>
        <dt>{{ $t('exchange.hlplus.fundingPeriod') }}</dt>
        <dd>{{ futuresTickerValue(futuresTicker.fundingPeriodId) }}</dd>
      </dl>
      <dl>
        <dt>{{ $t('exchange.hlplus.nextFundingTime') }}</dt>
        <dd>{{ futuresTickerValue(futuresTicker.nextFundingTime) }}</dd>
      </dl>
    </div>

    <!-- ══ body ═════════════════════════════════════════════════════════ -->
    <div class="ix-body" :style="deskBodyStyle">
      <!-- ── markets ──────────────────────────────────────────────────── -->
      <aside
        id="ix-market-drawer"
        class="ix-panel ix-markets"
        :class="{ 'is-open': marketsOpen }"
        @keydown.tab="trapMarketDrawerTab"
      >
        <!-- B5 — column resize; widths persist in local desk prefs (not money). -->
        <div
          class="ix-resizer ix-resizer-e"
          role="separator"
          aria-orientation="vertical"
          :aria-label="$t('exchange.residual.resizeMarkets')"
          :aria-valuemin="panelWidthMin('markets')"
          :aria-valuemax="panelWidthMax('markets')"
          :aria-valuenow="panelW.markets"
          :tabindex="panelResizeActive ? 0 : -1"
          @mousedown.prevent="startPanelResize('markets', $event)"
          @keydown="resizePanelByKey('markets', $event)"
        ></div>
        <div class="ix-markets-search">
          <input
            ref="marketSearch"
            type="text"
            v-model="searchKey"
            :placeholder="$t('exchange.residual.searchMarketSlash')"
            spellcheck="false"
            :aria-label="$t('exchange.terminal.searchMarket')"
            autocomplete="off"
          />
          <button
            type="button"
            class="ix-market-drawer-close"
            :aria-label="$t('common.close')"
            @click="closeMarkets(true)"
          >×</button>
        </div>
        <nav class="ix-tabs ix-tabs-sm" aria-label="Market list filter">
          <button
            type="button"
            v-if="isLogin"
            :class="{ 'is-active': baseFilter === 'favor' }"
            @click="baseFilter = 'favor'"
            :title="$t('exchange.residual.watchlistTitle')"
          >★</button>
          <button
            type="button"
            v-for="base in ['USDT', 'BTC', 'ETH']"
            :key="base"
            :class="{ 'is-active': baseFilter === base }"
            @click="baseFilter = base"
          >{{ base }}</button>
        </nav>
        <div class="ix-thead ix-thead-markets">
          <span>{{ $t('exchange.terminal.colPair') }}</span>
          <span class="ix-num">{{ $t('exchange.terminal.colLast') }}</span>
          <span class="ix-num">{{ $t('exchange.terminal.col24h') }}</span>
        </div>
        <div class="ix-scroll">
          <p class="ix-empty ix-empty-loading" v-if="marketsLoading">{{ $t("exchange.residual.loadingMarkets") }}</p>
          <p class="ix-empty ix-empty-error" v-else-if="!marketsReachable">
            {{ $t("exchange.residual.marketsUnavailable") }}
          </p>
          <template v-else>
            <!-- B6 — watchlist rail: favourites pinned above the full list -->
            <div
              class="ix-watch-rail"
              v-if="isLogin && baseFilter !== 'favor' && watchlistMarkets.length"
            >
              <div class="ix-watch-rail-hd">
                <span>{{ $t("exchange.residual.watchlist") }}</span>
                <button type="button" class="ix-linkish" @click="baseFilter = 'favor'">
                  {{ $t("exchange.residual.allWatch") }}
                </button>
              </div>
              <button
                type="button"
                class="ix-market-row ix-market-row-watch"
                :class="{ 'is-current': row.symbol === currentCoin.symbol }"
                v-for="row in watchlistMarkets"
                :key="'w-' + row.symbol"
                @click="openPair(row)"
              >
                <span class="ix-market-name">
                  <i class="ix-star ix-star-inline is-on" @click.stop="toggleRowFavorite(row)">
                    <Icon type="ios-star" size="12" />
                  </i>
                  {{ row.coin }}<em>/{{ row.base }}</em>
                </span>
                <span class="ix-num">{{ marketNum(row.close, 6) }}</span>
                <span class="ix-num" :class="roseClass(row.rose)">{{ marketStat(row.rose) }}</span>
              </button>
            </div>
            <p class="ix-empty" v-if="visibleMarkets.length === 0">{{ $t("exchange.terminal.noMarkets") }}</p>
            <button
              type="button"
              class="ix-market-row"
              :class="{ 'is-current': row.symbol === currentCoin.symbol }"
              v-for="row in visibleMarkets"
              :key="row.symbol"
              @click="openPair(row)"
            >
              <span class="ix-market-name">
                <i
                  class="ix-star ix-star-inline"
                  :class="{ 'is-on': row.isFavor }"
                  @click.stop="toggleRowFavorite(row)"
                >
                  <Icon :type="row.isFavor ? 'ios-star' : 'ios-star-outline'" size="12" />
                </i>
                {{ row.coin }}<em>/{{ row.base }}</em>
              </span>
              <span class="ix-num">{{ marketNum(row.close, 6) }}</span>
              <span class="ix-num" :class="roseClass(row.rose)">{{ marketStat(row.rose) }}</span>
            </button>
          </template>
        </div>
      </aside>

      <!-- ── centre: chart + account ──────────────────────────────────── -->
      <section class="ix-centre" aria-label="Exchange chart and activity">
        <section class="ix-panel ix-chart-panel">
          <nav class="ix-tabs ix-tabs-head">
            <button
              type="button"
              v-for="tab in mainTabs"
              :key="tab.id"
              :class="{ 'is-active': mainTab === tab.id }"
              @click="selectMainTab(tab.id)"
            >{{ tab.label }}</button>

            <div class="ix-intervals" v-show="mainTab === 'chart'">
              <button
                type="button"
                class="ix-study-toggle"
                :class="{ 'is-active': indicatorVisibility.rsi }"
                :aria-pressed="String(indicatorVisibility.rsi)"
                aria-label="Toggle RSI study pane"
                title="RSI study pane"
                @click="toggleIndicator('rsi')"
              >RSI</button>
              <button
                type="button"
                class="ix-study-toggle"
                :class="{ 'is-active': indicatorVisibility.macd }"
                :aria-pressed="String(indicatorVisibility.macd)"
                aria-label="Toggle MACD study pane"
                title="MACD study pane"
                @click="toggleIndicator('macd')"
              >MACD</button>
              <span class="ix-indicator-divider" aria-hidden="true"></span>
              <button
                type="button"
                v-for="tf in intervals"
                :key="tf.value"
                :class="{ 'is-active': interval === tf.value }"
                @click="setChartInterval(tf.value)"
              >{{ tf.label }}</button>
            </div>
            <button
              type="button"
              class="ix-layout-reset"
              title="Restore the default tabs, studies and column widths for this account"
              @click="resetDeskLayout"
            >Reset layout</button>
          </nav>
          <p v-if="layoutPrefsNotice" class="ix-layout-notice" role="status">{{ layoutPrefsNotice }}</p>

          <p class="ix-chart-capabilities" v-show="mainTab === 'chart'" role="note">
            <button type="button" disabled>Price alerts — no alerts API</button>
            <button
              type="button"
              class="ix-chart-reprice"
              :disabled="!amendOrder || submitting || !!pendingOutcome"
              :title="amendOrder ? 'Open the staged amend price. No order is sent from the chart.' : 'Choose Amend on an eligible open order first.'"
              @click="focusStagedReprice"
            >{{ amendOrder ? 'Reprice staged order · ' + shortOrderId(amendOrder) : 'Reprice — choose Amend below' }}</button>
            <button type="button" disabled>Multi-market — no trade API</button>
          </p>
          <section
            v-if="amendOrder && mainTab === 'chart'"
            class="ix-chart-reprice-stage"
            aria-label="Staged order reprice"
          >
            <dl>
              <div><dt>Order</dt><dd>{{ shortOrderId(amendOrder) }}</dd></div>
              <div><dt>Side</dt><dd>{{ side }}</dd></div>
              <div><dt>Original</dt><dd>{{ amendOrder.price }} {{ currentCoin.base }}</dd></div>
              <div><dt>Proposed</dt><dd>{{ form.price || '—' }} {{ currentCoin.base }}</dd></div>
              <div><dt>Delta</dt><dd>{{ repriceDeltaLabel }} {{ currentCoin.base }}</dd></div>
              <div><dt>Remaining</dt><dd>{{ repriceRemainingLabel }} {{ currentCoin.coin }}</dd></div>
            </dl>
            <div class="ix-chart-reprice-actions">
              <button type="button" :disabled="!chartRepriceAvailable" @click="nudgeChartReprice(-1)">
                Lower one tick
              </button>
              <button type="button" :disabled="!chartRepriceAvailable" @click="nudgeChartReprice(1)">
                Raise one tick
              </button>
              <button type="button" @click="focusStagedReprice">Edit exact price</button>
            </div>
            <p v-if="chartRepriceAvailable" role="note">
              Drag the staged line or use the tick controls. Release only updates this draft; Review amend is still required.
            </p>
            <p v-else role="status">
              Chart reprice unavailable: a loaded chart and service-authored tick size are required. The exact price field remains available.
            </p>
            <p role="note">The order API exposes no version predicate. Any changed, filled, cancelled, or missing row clears this stage before review.</p>
          </section>
          <p class="ix-chart-provenance" v-show="mainTab === 'chart'" role="status">
            {{ chartProvenanceLabel }}
          </p>
          <div class="ix-chart-controls" v-show="mainTab === 'chart'" aria-label="Chart view controls">
            <button type="button" @click="fitChartContent">Fit chart</button>
            <button type="button" @click="followLatestCandle">Follow latest</button>
          </div>
          <p id="ix-chart-summary" class="ix-chart-summary" v-show="mainTab === 'chart'">
            {{ chartAccessibleSummary }}
          </p>

          <div class="ix-chart-body">
            <!-- The chart host. Explicit height + overflow:hidden; the widget
                 fills it at 100% because `fullscreen` is off. -->
            <!--
              THE CHART HAS THREE STATES AND USED TO HAVE TWO.

              The overlay was gated on `!feedLive`, so with no live socket it
              covered the chart permanently — including when real candles had
              been drawn underneath it. And `chartFailed` was set from a loader
              that returned the same value for "no candles" and "request
              failed". Both are now distinct, and only 'ok' shows the canvas.
            -->
            <div
              id="ix_kline"
              class="ix-kline"
              v-show="mainTab === 'chart'"
              :class="{ 'is-empty': mainTab === 'chart' && chartStatus !== 'ok' }"
              :aria-hidden="chartStatus !== 'ok' ? 'true' : 'false'"
              :inert="chartStatus !== 'ok' ? '' : null"
              :tabindex="chartStatus === 'ok' ? '0' : '-1'"
              role="group"
              aria-label="Market candle chart. Use Left and Right Arrow to inspect candles, Home for oldest, End for latest."
              aria-describedby="ix-chart-summary ix-chart-provenance"
              @keydown="onChartKeydown"
            ></div>
            <!-- Empty copy must sit above the chart host (z-index) — silent black fails Gate 11 at a glance. -->
            <p
              class="ix-empty ix-empty-abs ix-empty-chart ix-empty-error"
              role="status"
              v-if="mainTab === 'chart' && chartStatus === 'failed'"
            >
              {{ $t("exchange.residual.chartUnavailableHonest") }}
            </p>
            <p
              class="ix-empty ix-empty-abs ix-empty-chart"
              role="status"
              v-else-if="mainTab === 'chart' && chartStatus === 'empty'"
            >
              {{ $t('intafaced.trade.noCandles') }}
            </p>
            <p class="ix-chart-attr" v-show="mainTab === 'chart'" role="contentinfo">
              {{ $t("exchange.residual.chartingBy") }}
              <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">{{ $t("exchange.residual.tradingView") }}</a>
              {{ $t("exchange.residual.lightweightCharts") }}
            </p>

            <div class="ix-depth-host" v-show="mainTab === 'depth'">
              <!-- IxState: loading / named refuse. Empty book is the graph overlay, never a 0 ladder. -->
              <IxState
                compact
                v-if="bookStateNamed"
                :loading="bookLoading"
                :reason="bookReason"
                :message="bookMessage"
                :endpoint="bookEndpoint"
              />
              <DepthGraph v-else ref="depthGraph" />
            </div>

            <div class="ix-book-full" v-show="mainTab === 'book'">
              <div
                class="ix-book-spread-strip"
                v-if="spread !== null && bookReachable && !bookStateNamed"
              >
                {{ $t("exchange.terminal.spread") }} {{ spread }}
              </div>
              <div v-if="bookStateNamed" class="ix-book-state">
                <IxState
                  compact
                  :loading="bookLoading"
                  :reason="bookReason"
                  :message="bookMessage"
                  :endpoint="bookEndpoint"
                />
              </div>
              <template v-else>
              <div class="ix-book-col">
                <div class="ix-thead ix-thead-book">
                  <span class="ix-num">{{ $t("exchange.terminal.colPriceIn", { unit: currentCoin.base }) }}</span>
                  <span class="ix-num">{{ $t("exchange.terminal.colAmountIn", { unit: currentCoin.coin }) }}</span>
                  <span class="ix-num">{{ $t("exchange.terminal.colTotal") }}</span>
                </div>
                <div class="ix-scroll">
                  <p class="ix-empty" v-if="bids.length === 0">{{ bookSideEmpty('bids') }}</p>
                  <template v-else>
                    <button
                      type="button"
                      class="ix-book-row is-bid"
                      v-for="(row, i) in bids"
                      :key="'fb' + i"
                      :aria-label="'Use bid price ' + fmt(row.price, baseCoinScale)"
                      @click="useBookPrice(row)"
                    >
                      <span class="ix-depth-bar" :style="{ width: barWidth(row, 'bid') }"></span>
                      <span class="ix-num ix-up">{{ fmt(row.price, baseCoinScale) }}</span>
                      <span class="ix-num">{{ fmt(row.amount, coinScale) }}</span>
                      <span class="ix-num ix-dim">{{ fmt(row.totalAmount, coinScale) }}</span>
                    </button>
                  </template>
                </div>
              </div>
              <div class="ix-book-col">
                <div class="ix-thead ix-thead-book">
                  <span class="ix-num">{{ $t("exchange.terminal.colPriceIn", { unit: currentCoin.base }) }}</span>
                  <span class="ix-num">{{ $t("exchange.terminal.colAmountIn", { unit: currentCoin.coin }) }}</span>
                  <span class="ix-num">{{ $t("exchange.terminal.colTotal") }}</span>
                </div>
                <div class="ix-scroll">
                  <p class="ix-empty" v-if="asksAscending.length === 0">{{ bookSideEmpty('asks') }}</p>
                  <template v-else>
                    <button
                      type="button"
                      class="ix-book-row is-ask"
                      v-for="(row, i) in asksAscending"
                      :key="'fa' + i"
                      :aria-label="'Use ask price ' + fmt(row.price, baseCoinScale)"
                      @click="useBookPrice(row)"
                    >
                      <span class="ix-depth-bar" :style="{ width: barWidth(row, 'ask') }"></span>
                      <span class="ix-num ix-down">{{ fmt(row.price, baseCoinScale) }}</span>
                      <span class="ix-num">{{ fmt(row.amount, coinScale) }}</span>
                      <span class="ix-num ix-dim">{{ fmt(row.totalAmount, coinScale) }}</span>
                    </button>
                  </template>
                </div>
              </div>
              </template>
            </div>

            <div class="ix-trades-full" v-show="mainTab === 'trades'">
              <div class="ix-thead ix-thead-trades-full">
                <span>{{ $t("exchange.terminal.colTime") }}</span>
                <span class="ix-num">{{ $t("exchange.terminal.colPriceIn", { unit: currentCoin.base }) }}</span>
                <span class="ix-num">{{ $t("exchange.terminal.colAmountIn", { unit: currentCoin.coin }) }}</span>
                <span class="ix-num">{{ $t("exchange.terminal.colValue") }}</span>
              </div>
              <div class="ix-scroll">
                <p
                  class="ix-empty"
                  :class="{ 'ix-empty-loading': tradesLoading, 'ix-empty-error': !tradesLoading && !tradesReachable }"
                  v-if="tradesLoading || !tradesReachable || trades.length === 0"
                >{{ tradesEmptyLabel }}</p>
                <template v-if="tradesReachable && !tradesLoading">
                  <div class="ix-trade-row is-wide" v-for="(row, i) in trades" :key="'ft' + i">
                    <span class="ix-dim">{{ time(row.time) }}</span>
                    <span class="ix-num" :class="row.direction === 'BUY' ? 'ix-up' : 'ix-down'">
                      {{ fmt(row.price, baseCoinScale) }}
                    </span>
                    <span class="ix-num">{{ fmt(row.amount, coinScale) }}</span>
                    <span class="ix-num ix-dim">{{ fmt(turnoverOf(row), 2) }}</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>

        <section class="ix-panel ix-account">
          <nav class="ix-tabs ix-tabs-head">
            <button
              type="button"
              v-for="tab in accountTabs"
              :key="tab.id"
              :class="{ 'is-active': accountTab === tab.id }"
              @click="accountTab = tab.id"
            >
              {{ tab.label }}<sup v-if="tab.count">{{ tab.count }}</sup>
            </button>
          </nav>

          <div class="ix-account-body">
            <p
              class="ix-empty ix-empty-error"
              v-if="activeAccountTab && activeAccountTab.availability === 'unavailable'"
            >{{ activeAccountTab.reason }}</p>

            <div v-else-if="accountTab === 'funding-history'" id="funding-history">
              <p class="ix-empty ix-empty-error" v-if="!fundingHistoryReachable">
                {{ fundingHistoryMessage || $t('exchange.hlplus.futuresTickerUnavailable') }}
              </p>
              <p class="ix-empty" v-else-if="fundingHistory.length === 0">
                {{ $t('intafaced.state.empty') }}
              </p>
              <table class="ix-table" v-else>
                <thead>
                  <tr>
                    <th>{{ $t('exchange.terminal.colMarket') }}</th>
                    <th>{{ $t('exchange.hlplus.fundingPeriod') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.fundingRate') }}</th>
                    <th>{{ $t('exchange.hlplus.nextFundingTime') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in fundingHistory" :key="row.symbol + ':' + row.periodId">
                    <td class="ix-strong">{{ row.symbol }}</td>
                    <td>{{ row.periodId }}</td>
                    <td class="ix-num">{{ row.rate }}</td>
                    <td>{{ row.periodEnd || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p class="ix-empty" v-else-if="!isLogin">
              {{ $t('intafaced.trade.noSession') }}
              <router-link to="/platform">{{ $t('intafaced.state.goSignIn') }}</router-link>
            </p>

            <p class="ix-empty ix-empty-loading" v-else-if="accountLoading">
              {{ $t("exchange.terminal.accountLoading") }}
            </p>

            <p class="ix-empty ix-empty-error" v-else-if="accountError">
              {{ accountError }}
            </p>

            <!-- Balances — the INTAFACED ledger, the single book -->
            <div v-else-if="accountTab === 'balances'">
              <p class="ix-empty ix-empty-note">
                {{ $t('intafaced.trade.ledgerNote') }} · <code>GET /api/v1/account/balance</code>
              </p>
              <p class="ix-empty ix-empty-error" v-if="!walletReachable">
                {{ $t("exchange.residual.ledgerUnknownBalances") }}
              </p>
              <!-- A ledger with no rows for this account is an ANSWER. It is not
                   a table of every asset at 0.00, which would claim we hold
                   assets we have never held a row for. -->
              <p class="ix-empty" v-else-if="balanceRows.length === 0">
                {{ $t('intafaced.trade.noBalances') }}
              </p>
              <table class="ix-table" v-else>
                <thead>
                  <tr>
                    <th>{{ $t('exchange.terminal.colAsset') }}</th>
                    <th class="ix-num">{{ $t('exchange.residual.free') }}</th>
                    <th class="ix-num">{{ $t('exchange.residual.held') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colTotal') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <!-- Decimal strings, printed as strings. -->
                  <tr v-for="row in balanceRows" :key="row.unit">
                    <td class="ix-strong">{{ row.unit }}</td>
                    <td class="ix-num">{{ row.free }}</td>
                    <td class="ix-num ix-dim">{{ row.used }}</td>
                    <td class="ix-num">{{ row.total }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Positions -->
            <div v-else-if="accountTab === 'positions'">
              <p class="ix-dualbook" role="note" v-if="!isPerpKind">
                {{ $t("exchange.residual.spotNoPerps") }}
              </p>
              <p class="ix-empty ix-empty-error" v-else-if="!positionsReachable">
                {{ positionsMessage || $t('exchange.hlplus.positionsUnavailable') }}
              </p>
              <p class="ix-empty" v-else-if="positions.length === 0">
                {{ $t("exchange.terminal.noPositions") }}
              </p>
              <table class="ix-table" v-else>
                <thead>
                  <tr>
                    <th>{{ $t('exchange.terminal.colMarket') }}</th>
                    <th>{{ $t('exchange.terminal.colSide') }}</th>
                    <th>{{ $t('exchange.hlplus.positionStatus') }}</th>
                    <th>{{ $t('exchange.hlplus.marginMode') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.positionSize') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.entryPrice') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.leverage') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.markPrice') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.unrealizedPnl') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.initialMargin') }}</th>
                    <th class="ix-num">{{ $t('exchange.hlplus.liquidationPrice') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in positions" :key="row.id">
                    <td class="ix-strong">{{ row.symbol }}</td>
                    <td :class="row.side === 'long' ? 'ix-up' : 'ix-down'">{{ positionSideLabel(row.side) }}</td>
                    <td>{{ row.status }}</td>
                    <td>{{ row.marginMode }}</td>
                    <td class="ix-num">{{ positionValue(row.contracts) }}</td>
                    <td class="ix-num">{{ positionValue(row.entryPrice) }}</td>
                    <td class="ix-num">{{ positionValue(row.leverage) }}</td>
                    <td class="ix-num">{{ positionValue(row.markPrice) }}</td>
                    <td class="ix-num" :class="positionPnlClass(row.unrealizedPnl)">{{ positionValue(row.unrealizedPnl) }}</td>
                    <td class="ix-num">{{ isolatedInitialMargin(row) }}</td>
                    <td class="ix-num">{{ positionValue(row.liquidationPrice) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Open orders -->
            <div v-else-if="accountTab === 'open'">
              <p class="ix-empty ix-empty-error" v-if="!openOrdersReachable">
                {{ $t("exchange.residual.openOrdersUnknown") }}
                <button
                  v-if="allOpenOrdersReachable && allOpenOrders.length"
                  type="button"
                  class="ix-mass-cancel ix-mass-cancel-all"
                  :disabled="!!massCancelScope || isMassCancelPending || allOpenOrders.length === 500"
                  @click="cancelAllOrders('all')"
                >{{ $t("exchange.residual.cancelAllMarkets", { count: allOpenOrders.length }) }}</button>
              </p>
              <template v-else>
                <div class="ix-blotter-tools">
                  <button
                    type="button"
                    class="ix-linkish"
                    :disabled="!openOrders.length"
                    @click="exportOpenOrdersCsv"
                  >{{ $t("exchange.residual.exportCsv") }}</button>
                  <button
                    v-if="openOrdersReachable && openOrders.length"
                    type="button"
                    class="ix-mass-cancel"
                    :disabled="!!massCancelScope || isMassCancelPending || openOrders.length === 500"
                    @click="cancelAllOrders('symbol')"
                  >{{ $t("exchange.residual.cancelAllSymbol", { symbol: currentCoin.symbol, count: openOrders.length }) }}</button>
                  <button
                    v-if="allOpenOrdersReachable && allOpenOrders.length"
                    type="button"
                    class="ix-mass-cancel ix-mass-cancel-all"
                    :disabled="!!massCancelScope || isMassCancelPending || allOpenOrders.length === 500"
                    @click="cancelAllOrders('all')"
                  >{{ $t("exchange.residual.cancelAllMarkets", { count: allOpenOrders.length }) }}</button>
                </div>
                <p class="ix-empty" v-if="openOrders.length === 0">{{ $t("exchange.residual.noOpenOrders") }}</p>
                <table class="ix-table" v-else>
                  <thead>
                    <tr>
                      <th>{{ $t('exchange.terminal.colTime') }}</th>
                      <th>{{ $t('exchange.terminal.colMarket') }}</th>
                      <th>{{ $t('exchange.terminal.colType') }}</th>
                      <th>{{ $t('exchange.terminal.colSide') }}</th>
                      <th class="ix-num">{{ $t('exchange.terminal.colPrice') }}</th>
                      <th class="ix-num">{{ $t('exchange.terminal.colAmount') }}</th>
                      <th class="ix-num">{{ $t('exchange.terminal.colFilled') }}</th>
                      <th class="ix-num">{{ $t('exchange.terminal.colValue') }}</th>
                      <th>{{ $t('exchange.residual.colOutcome') }}</th>
                      <th class="ix-num"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, i) in openOrders" :key="row.orderId || i">
                      <td class="ix-dim">{{ date(row.time) }}</td>
                      <td>{{ row.symbol }}</td>
                      <td class="ix-dim">{{ orderTypeLabel(row) }}</td>
                      <td :class="row.direction === 'BUY' ? 'ix-up' : 'ix-down'">
                        {{ row.direction === 'BUY' ? $t('exchange.terminal.buy') : $t('exchange.terminal.sell') }}
                      </td>
                      <td class="ix-num">{{ priceLabel(row) }}</td>
                      <td class="ix-num">{{ dec(row.amount) }}</td>
                      <td class="ix-num" :title="fillTitle(row)">{{ fillLabel(row) }}</td>
                      <td class="ix-num">{{ dec(row.turnover) }}</td>
                      <td :class="outcomeClass(row)">{{ outcomeLabel(row) }}</td>
                      <td class="ix-num ix-actions">
                        <button
                          type="button"
                          class="ix-linkish"
                          :title="$t('exchange.residual.copyOrderId') + ' ' + (row.orderId || '')"
                          @click="copyOrderId(row)"
                        >ID</button>
                        <button
                          type="button"
                          class="ix-cancel"
                          :disabled="!!cancellingId || isIndividualActionBlocked"
                          :aria-label="'Cancel order ' + (row.orderId || '')"
                          @click="cancelOrder(row)"
                        >{{ cancellingId === row.orderId ? $t('exchange.residual.cancelling') : $t('exchange.terminal.cancel') }}</button>
                        <button
                          type="button"
                          class="ix-linkish"
                          :disabled="!canAmendOrder(row) || !!cancellingId || isIndividualActionBlocked || submitting"
                          :title="$t('exchange.residual.amendEligible')"
                          @click="beginAmend(row)"
                        >{{ $t('exchange.residual.amend') }}</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </template>
            </div>

            <!-- Trade history (fills) -->
            <p class="ix-empty ix-empty-error" v-else-if="accountTab === 'fills' && !fillsReachable">
              {{ $t("exchange.residual.fillsUnknown") }}
            </p>
            <table class="ix-table" v-else-if="accountTab === 'fills'">
              <thead>
                <tr>
                  <th>{{ $t('exchange.terminal.colTime') }}</th>
                  <th>{{ $t('exchange.terminal.colMarket') }}</th>
                  <th>{{ $t('exchange.terminal.colSide') }}</th>
                  <th>{{ $t('exchange.residual.role') }}</th>
                  <th class="ix-num">{{ $t('exchange.terminal.colPrice') }}</th>
                  <th class="ix-num">{{ $t('exchange.terminal.colAmount') }}</th>
                  <th class="ix-num">{{ $t('exchange.terminal.colValue') }}</th>
                  <th class="ix-num">{{ $t('exchange.terminal.colFee') }}</th>
                </tr>
              </thead>
              <tbody>
                <!-- Decimal strings, printed as strings. -->
                <tr v-for="(row, i) in fills" :key="'fill' + i">
                  <td class="ix-dim">{{ date(row.time) }}</td>
                  <td>{{ row.symbol }}</td>
                  <td :class="row.direction === 'BUY' ? 'ix-up' : 'ix-down'">
                    {{ row.direction === 'BUY' ? $t('exchange.terminal.buy') : $t('exchange.terminal.sell') }}
                  </td>
                  <td class="ix-dim">{{ row.liquidity || '—' }}</td>
                  <td class="ix-num">{{ dec(row.price) }}</td>
                  <td class="ix-num">{{ dec(row.amount) }}</td>
                  <td class="ix-num">{{ dec(row.turnover) }}</td>
                  <td class="ix-num ix-dim">{{ dec(row.fee) }} {{ row.feeAsset || '' }}</td>
                </tr>
              </tbody>
            </table>

            <!-- Order history -->
            <p class="ix-empty ix-empty-error" v-else-if="accountTab === 'history' && !ordersReachable">
              {{ $t("exchange.residual.orderHistoryUnknown") }}
            </p>
            <div v-else-if="accountTab === 'history'">
              <div class="ix-blotter-tools" v-if="ordersReachable && historyOrders.length">
                <button
                  type="button"
                  class="ix-linkish"
                  @click="exportHistoryOrdersCsv"
                >{{ $t("exchange.residual.exportCsv") }}</button>
              </div>
              <p class="ix-empty" v-if="!historyOrders.length">{{ $t("exchange.residual.noOrderHistory") }}</p>
              <table class="ix-table" v-else>
                <thead>
                  <tr>
                    <th>{{ $t('exchange.terminal.colTime') }}</th>
                    <th>{{ $t('exchange.terminal.colMarket') }}</th>
                    <th>{{ $t('exchange.terminal.colType') }}</th>
                    <th>{{ $t('exchange.terminal.colSide') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colPrice') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colAmount') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colFilled') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colValue') }}</th>
                    <th>{{ $t('exchange.terminal.colStatus') }}</th>
                    <th class="ix-num"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in historyOrders" :key="row.orderId || 'h' + i">
                    <td class="ix-dim">{{ date(row.time) }}</td>
                    <td>{{ row.symbol }}</td>
                    <td class="ix-dim">{{ row.type === 'MARKET_PRICE' ? $t('exchange.terminal.typeMarket') : $t('exchange.terminal.typeLimit') }}</td>
                    <td :class="row.direction === 'BUY' ? 'ix-up' : 'ix-down'">
                      {{ row.direction === 'BUY' ? $t('exchange.terminal.buy') : $t('exchange.terminal.sell') }}
                    </td>
                    <td class="ix-num">{{ priceLabel(row) }}</td>
                    <td class="ix-num">{{ dec(row.amount) }}</td>
                    <td class="ix-num" :title="fillTitle(row)">{{ fillLabel(row) }}</td>
                    <td class="ix-num">{{ dec(row.turnover) }}</td>
                    <td :class="statusClass(row)">{{ statusLabel(row) }}</td>
                    <td class="ix-num ix-actions">
                      <button
                        type="button"
                        class="ix-linkish"
                        :title="$t('exchange.residual.copyOrderId') + ' ' + (row.orderId || '')"
                        @click="copyOrderId(row)"
                      >ID</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Drop-copy evidence (independent of Trade History / private fills). -->
            <div v-else-if="accountTab === 'drop-copy'">
              <p class="ix-empty ix-empty-note">{{ $t('exchange.hlplus.dropCopyNote') }}</p>
              <div class="ix-meta">
                <div><dt>{{ $t('exchange.hlplus.dropCopyCompleteness') }}</dt><dd>{{ dropCopyView.completeness }}</dd></div>
                <div><dt>{{ $t('exchange.hlplus.dropCopyReplay') }}</dt><dd>{{ $t('exchange.hlplus.dropCopyReplaySession') }}</dd></div>
              </div>
              <p
                class="ix-order-note"
                v-if="dropCopyView.lastCode === 'drop_copy.recovery_required' || dropCopyView.completeness === 'RECOVERY_REQUIRED'"
              >{{ $t('exchange.hlplus.dropCopyRecovery') }}</p>
              <p
                class="ix-order-note"
                v-else-if="dropCopyView.lastCode === 'drop_copy.common_upstream_failure' || dropCopyView.completeness === 'COMMON_UPSTREAM_FAILURE'"
              >{{ $t('exchange.hlplus.dropCopyUpstream') }}</p>
              <p
                class="ix-order-note"
                v-else-if="dropCopyView.lastCode === 'drop_copy.gap'"
              >{{ $t('exchange.hlplus.dropCopyGap') }}</p>
              <p class="ix-empty" v-if="dropCopyView.executions.length === 0">{{ $t('exchange.hlplus.dropCopyEmpty') }}</p>
              <table class="ix-table" v-else>
                <thead>
                  <tr>
                    <th>{{ $t('exchange.terminal.colTime') }}</th>
                    <th>{{ $t('exchange.terminal.colMarket') }}</th>
                    <th>{{ $t('exchange.terminal.colSide') }}</th>
                    <th>{{ $t('exchange.residual.role') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colPrice') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colAmount') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colValue') }}</th>
                    <th class="ix-num">{{ $t('exchange.terminal.colFee') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in dropCopyView.executions" :key="row.fillId">
                    <td class="ix-dim">{{ row.ts || '—' }}</td>
                    <td>{{ row.marketId }}</td>
                    <td :class="row.side === 'buy' ? 'ix-up' : 'ix-down'">{{ row.side || '—' }}</td>
                    <td class="ix-dim">{{ row.liquidity || '—' }}</td>
                    <td class="ix-num">{{ row.price || '—' }}</td>
                    <td class="ix-num">{{ row.qty || '—' }}</td>
                    <td class="ix-num">{{ row.quoteAmount || '—' }}</td>
                    <td class="ix-num ix-dim">{{ row.feeAmount || '—' }} {{ row.feeAsset || '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p class="ix-empty" v-if="isLogin && !accountLoading && !accountError && accountTabEmpty">{{ $t("exchange.terminal.nothingYet") }}</p>
          </div>
        </section>
      </section>

      <!-- ── order book / trades rail ─────────────────────────────────── -->
      <aside class="ix-panel ix-rail">
        <div
          class="ix-resizer ix-resizer-w"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize book column"
          :aria-valuemin="panelWidthMin('order')"
          :aria-valuemax="panelWidthMax('order')"
          :aria-valuenow="panelW.order"
          :tabindex="panelResizeActive ? 0 : -1"
          @mousedown.prevent="startPanelResize('order', $event)"
          @keydown="resizePanelByKey('order', $event)"
        ></div>
        <nav class="ix-tabs ix-tabs-head">
          <button
            type="button"
            :class="{ 'is-active': railTab === 'book' }"
            @click="railTab = 'book'"
          >{{ $t("exchange.terminal.tabBook") }}</button>
          <button
            type="button"
            :class="{ 'is-active': railTab === 'trades' }"
            @click="railTab = 'trades'"
          >{{ $t("exchange.terminal.tabTrades") }}</button>
          <div class="ix-book-modes" v-show="railTab === 'book'">
            <button
              type="button"
              v-for="m in bookModes"
              :key="m.id"
              :class="['ix-book-mode', 'is-' + m.id, { 'is-active': bookMode === m.id }]"
              :title="m.label"
              @click="bookMode = m.id"
            ><i></i><i></i></button>
            <select
              class="ix-book-group"
              v-model.number="bookGroup"
              :title="$t('exchange.residual.priceGrouping')"
              aria-label="Order book price grouping"
            >
              <option v-for="g in bookGroups" :key="g" :value="g">{{ g === 1 ? $t('exchange.residual.oneTick') : '×' + g }}</option>
            </select>
          </div>
        </nav>

        <div class="ix-rail-body" v-show="railTab === 'book'">
          <div class="ix-thead ix-thead-book">
            <span class="ix-num">{{ $t("exchange.terminal.colPrice") }}</span>
            <span class="ix-num">{{ $t("exchange.terminal.colAmount") }}</span>
            <span class="ix-num">{{ $t("exchange.terminal.colTotal") }}</span>
          </div>

          <IxState
            compact
            v-if="bookStateNamed"
            :loading="bookLoading"
            :reason="bookReason"
            :message="bookMessage"
            :endpoint="bookEndpoint"
          />
          <template v-else>
          <div class="ix-book-side ix-book-asks" v-show="bookMode !== 'bids'">
            <p class="ix-empty" v-if="asks.length === 0">{{ bookSideEmpty('asks') }}</p>
            <template v-else>
              <button
                type="button"
                class="ix-book-row is-ask"
                v-for="(row, i) in asks"
                :key="'a' + i"
                :aria-label="'Use ask price ' + zero(row.price, baseCoinScale)"
                @click="useBookPrice(row)"
              >
                <span class="ix-depth-bar" :style="{ width: barWidth(row, 'ask') }"></span>
                <span class="ix-num ix-down">{{ zero(row.price, baseCoinScale) }}</span>
                <span class="ix-num">{{ zero(row.amount, coinScale) }}</span>
                <span class="ix-num ix-dim">{{ zero(row.totalAmount, coinScale) }}</span>
              </button>
            </template>
          </div>

          <div class="ix-book-mid">
            <span class="ix-book-price" :class="trendClass">{{ lastPriceLabel }}</span>
            <Icon v-if="trend > 0" type="md-arrow-up" class="ix-up" size="14" />
            <Icon v-else-if="trend < 0" type="md-arrow-down" class="ix-down" size="14" />
            <span class="ix-book-spread" v-if="spread !== null && bookReachable">{{ $t("exchange.terminal.spread") }} {{ spread }}</span>
          </div>

          <div class="ix-book-side ix-book-bids" v-show="bookMode !== 'asks'">
            <p class="ix-empty" v-if="bids.length === 0">{{ bookSideEmpty('bids') }}</p>
            <template v-else>
              <button
                type="button"
                class="ix-book-row is-bid"
                v-for="(row, i) in bids"
                :key="'b' + i"
                :aria-label="'Use bid price ' + zero(row.price, baseCoinScale)"
                @click="useBookPrice(row)"
              >
                <span class="ix-depth-bar" :style="{ width: barWidth(row, 'bid') }"></span>
                <span class="ix-num ix-up">{{ zero(row.price, baseCoinScale) }}</span>
                <span class="ix-num">{{ zero(row.amount, coinScale) }}</span>
                <span class="ix-num ix-dim">{{ zero(row.totalAmount, coinScale) }}</span>
              </button>
            </template>
          </div>
          </template>
        </div>

        <div class="ix-rail-body" v-show="railTab === 'trades'">
          <div class="ix-thead ix-thead-trades">
            <span>{{ $t("exchange.terminal.colTime") }}</span>
            <span class="ix-num">{{ $t("exchange.terminal.colPrice") }}</span>
            <span class="ix-num">{{ $t("exchange.terminal.colAmount") }}</span>
          </div>
          <div class="ix-scroll">
            <p
              class="ix-empty"
              :class="{ 'ix-empty-loading': tradesLoading, 'ix-empty-error': !tradesLoading && !tradesReachable }"
              v-if="tradesLoading || !tradesReachable || trades.length === 0"
            >{{ tradesEmptyLabel }}</p>
            <template v-if="tradesReachable && !tradesLoading">
              <div class="ix-trade-row" v-for="(row, i) in trades" :key="'t' + i">
                <span class="ix-dim">{{ time(row.time) }}</span>
                <span class="ix-num" :class="row.direction === 'BUY' ? 'ix-up' : 'ix-down'">
                  {{ fmt(row.price, baseCoinScale) }}
                </span>
                <span class="ix-num">{{ fmt(row.amount, coinScale) }}</span>
              </div>
            </template>
          </div>
        </div>
      </aside>

      <!-- ── order entry ──────────────────────────────────────────────── -->
      <aside id="ix-ticket" class="ix-panel ix-order" :class="{ 'is-refused': ticketMarketUnavailable }" tabindex="-1" aria-label="Order ticket">
        <div
          class="ix-resizer ix-resizer-w"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize order ticket column"
          :aria-valuemin="panelWidthMin('order')"
          :aria-valuemax="panelWidthMax('order')"
          :aria-valuenow="panelW.order"
          :tabindex="panelResizeActive ? 0 : -1"
          @mousedown.prevent="startPanelResize('order', $event)"
          @keydown="resizePanelByKey('order', $event)"
        ></div>
        <div class="ix-side-toggle ix-mode-strip" role="group" aria-label="Trading mode">
          <button
            type="button"
            :class="{ 'is-active': deskMode === 'spot' }"
            :aria-pressed="deskMode === 'spot' ? 'true' : 'false'"
            @click="setDeskKind('spot')"
          >{{ $t('exchange.terminal.spot') }}</button>
          <button
            type="button"
            :class="{ 'is-active': deskMode === 'perp' }"
            :aria-pressed="deskMode === 'perp' ? 'true' : 'false'"
            @click="setDeskKind('perp')"
          >{{ $t('exchange.hlplus.perps') }}</button>
          <button
            type="button"
            :class="{ 'is-active': deskMode === 'convert' }"
            :aria-pressed="deskMode === 'convert' ? 'true' : 'false'"
            @click="deskMode = 'convert'"
          >{{ $t('exchange.convert.title') }}</button>
          <button
            type="button"
            :class="{ 'is-active': deskMode === 'copy' }"
            :aria-pressed="deskMode === 'copy' ? 'true' : 'false'"
            @click="deskMode = 'copy'"
          >{{ $t('intafaced.exchange.copy.title') }}</button>
          <button
            type="button"
            :class="{ 'is-active': deskMode === 'options' }"
            :aria-pressed="deskMode === 'options' ? 'true' : 'false'"
            @click="deskMode = 'options'"
          >{{ $t('intafaced.exchange.options.title') }}</button>
        </div>

        <div v-if="deskMode === 'convert'" class="ix-order-body">
          <div class="ix-side-toggle" role="group" aria-label="Convert side">
            <button type="button" :class="{ 'is-active': convertSide === 'buy' }" @click="convertSide = 'buy'">{{ $t('exchange.terminal.buy') }}</button>
            <button type="button" :class="{ 'is-active': convertSide === 'sell' }" @click="convertSide = 'sell'">{{ $t('exchange.terminal.sell') }}</button>
          </div>
          <div class="ix-field">
            <label for="ix-convert-qty">{{ $t('exchange.convert.quantity') }}</label>
            <div class="ix-input">
              <input id="ix-convert-qty" type="text" inputmode="decimal" spellcheck="false" v-model="convertQty" @input="convertError = ''" />
              <span class="ix-unit">{{ currentCoin.coin }}</span>
            </div>
          </div>
          <button type="button" class="ix-submit is-buy" :disabled="!isLogin || !currentCoin.symbol || !convertQty || convertLoading" @click="quoteConvert">
            {{ convertLoading ? $t('exchange.convert.quoting') : $t('exchange.convert.quote') }}
          </button>
          <p v-if="convertError" class="ix-order-note ix-order-error">{{ convertError }}</p>
          <div v-if="convertQuote" class="ix-meta">
            <div><dt>{{ $t('exchange.convert.requestedQty') }}</dt><dd>{{ convertQuote.requestedQty }}</dd></div>
            <div><dt>{{ $t('exchange.convert.filledQty') }}</dt><dd>{{ convertQuote.filledQty }}</dd></div>
            <div><dt>{{ $t('exchange.convert.avgPrice') }}</dt><dd>{{ convertQuote.avgPrice }}</dd></div>
            <div><dt>{{ $t('exchange.convert.spread') }}</dt><dd>{{ convertQuote.convertSpreadBps }} bps</dd></div>
            <div><dt>{{ $t('exchange.convert.expires') }}</dt><dd>{{ convertQuote.expiresAt }}</dd></div>
          </div>
          <button type="button" class="ix-submit is-buy" :disabled="!convertCanExecute || convertExecuting" @click="executeConvert">
            {{ convertExecuting ? $t('exchange.convert.executing') : $t('exchange.convert.execute') }}
          </button>
          <p v-if="convertResult" class="ix-order-note">{{ convertResult.status }} · {{ $t('exchange.convert.orderId') }}: {{ convertResult.orderId }}</p>
          <p v-else-if="!isLogin" class="ix-order-note"><router-link to="/platform">{{ $t('exchange.convert.signIn') }}</router-link></p>
        </div>

        <div v-else-if="deskMode === 'options'" class="ix-order-body">
          <p class="ix-order-note">{{ $t('intafaced.exchange.options.lead') }}</p>
          <p class="ix-order-note">{{ $t('intafaced.exchange.options.empty') }}</p>
          <IxState
            compact
            reason="no_surface"
            :message="$t('intafaced.exchange.options.chainUnavailable')"
            endpoint="options.chain"
          />
        </div>

        <div v-else-if="deskMode === 'copy'" class="ix-order-body">
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.lead') }}</p>
          <section class="ix-ticket-refusal ix-ticket-door-refusal" role="status">
            <strong>{{ $t('exchange.residual.rfqUnavailable') }}</strong>
            <span>{{ $t('intafaced.exchange.copy.rfqRefuse') }}</span>
          </section>
          <div class="ix-field">
            <label for="ix-copy-leader">{{ $t('intafaced.exchange.copy.leaderId') }}</label>
            <div class="ix-input">
              <input id="ix-copy-leader" type="text" spellcheck="false" autocomplete="off" v-model="copyLeaderId" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-region">{{ $t('intafaced.exchange.copy.region') }}</label>
            <div class="ix-input">
              <input id="ix-copy-region" type="text" spellcheck="false" autocomplete="off" v-model="copyRegion" @input="copyError = ''" />
            </div>
          </div>
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.regionHint') }}</p>
          <div class="ix-field">
            <label for="ix-copy-markets">{{ $t('intafaced.exchange.copy.markets') }}</label>
            <div class="ix-input">
              <input id="ix-copy-markets" type="text" spellcheck="false" autocomplete="off" v-model="copyPermittedMarkets" @input="copyError = ''" />
            </div>
          </div>
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.marketsHint') }}</p>
          <div class="ix-field">
            <label for="ix-copy-max-notional">{{ $t('intafaced.exchange.copy.maxNotional') }}</label>
            <div class="ix-input">
              <input id="ix-copy-max-notional" type="text" inputmode="decimal" spellcheck="false" v-model="copyMaxNotionalPerOrder" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-max-exposure">{{ $t('intafaced.exchange.copy.maxExposure') }}</label>
            <div class="ix-input">
              <input id="ix-copy-max-exposure" type="text" inputmode="decimal" spellcheck="false" v-model="copyMaxAggregateExposure" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-expires">{{ $t('intafaced.exchange.copy.expires') }}</label>
            <div class="ix-input">
              <input id="ix-copy-expires" type="text" spellcheck="false" autocomplete="off" v-model="copyExpiresAt" @input="copyError = ''" />
            </div>
          </div>
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.expiresHint') }}</p>
          <button type="button" class="ix-submit is-buy" :disabled="!isLogin || copyFollowing" @click="submitCopyFollow">
            {{ copyFollowing ? $t('intafaced.exchange.copy.following') : $t('intafaced.exchange.copy.follow') }}
          </button>
          <p v-if="copyError" class="ix-order-note ix-order-error">{{ copyError }}</p>
          <p v-else-if="!isLogin" class="ix-order-note"><router-link to="/platform">{{ $t('intafaced.exchange.copy.signIn') }}</router-link></p>
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.list') }}</p>
          <p v-if="copyFollowsLoading" class="ix-order-note">{{ $t('intafaced.exchange.copy.loading') }}</p>
          <p v-else-if="copyFollowsReachable && copyFollows.length === 0" class="ix-order-note">{{ $t('intafaced.exchange.copy.empty') }}</p>
          <div v-else-if="copyFollowsReachable" class="ix-meta" v-for="row in copyFollows" :key="row.followId">
            <div><dt>{{ $t('intafaced.exchange.copy.leaderId') }}</dt><dd>{{ row.leaderId }}</dd></div>
            <div><dt>{{ $t('intafaced.exchange.copy.region') }}</dt><dd>{{ row.region }}</dd></div>
            <div><dt>{{ $t('intafaced.exchange.copy.maxNotional') }}</dt><dd>{{ row.maxNotionalPerOrder }}</dd></div>
            <div><dt>{{ $t('intafaced.exchange.copy.maxExposure') }}</dt><dd>{{ row.maxAggregateExposure }}</dd></div>
            <div><dt>{{ $t('intafaced.exchange.copy.expires') }}</dt><dd>{{ row.expiresAt }}</dd></div>
            <div><dt>{{ $t('intafaced.exchange.copy.sessionKey') }}</dt><dd>{{ row.sessionKeyPrefix || (row.sessionKeyRevoked ? $t('intafaced.exchange.copy.sessionRevoked') : $t('intafaced.exchange.copy.sessionNone')) }}</dd></div>
            <button type="button" class="ix-submit is-buy" :disabled="copyGrantingId === row.followId" @click="grantCopySession(row.followId)">
              {{ copyGrantingId === row.followId ? $t('intafaced.exchange.copy.granting') : $t('intafaced.exchange.copy.grantSession') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyKillingId === row.followId" @click="killCopySession(row.followId)">
              {{ copyKillingId === row.followId ? $t('intafaced.exchange.copy.killing') : $t('intafaced.exchange.copy.killSession') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyUnfollowingId === row.followId" @click="unfollowCopy(row.followId)">
              {{ $t('intafaced.exchange.copy.unfollow') }}
            </button>
            <div><dt>{{ $t('intafaced.exchange.copy.state') }}</dt><dd>{{ row.relationshipState || 'ACTIVE' }}</dd></div>
            <button type="button" class="ix-submit" :disabled="copyActingId === ('pause:' + row.followId)" @click="copyControl('pause', row.followId)">
              {{ $t('intafaced.exchange.copy.pause') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyActingId === ('resume:' + row.followId)" @click="copyControl('resume', row.followId)">
              {{ $t('intafaced.exchange.copy.resume') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyActingId === ('stop:' + row.followId)" @click="copyControl('stop', row.followId)">
              {{ $t('intafaced.exchange.copy.stop') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyActingId === ('detach:' + row.followId)" @click="copyControl('detach', row.followId)">
              {{ $t('intafaced.exchange.copy.detach') }}
            </button>
            <button type="button" class="ix-submit" :disabled="copyActingId === ('flatten:' + row.followId)" @click="copyControl('flatten', row.followId)">
              {{ $t('intafaced.exchange.copy.flatten') }}
            </button>
          </div>
          <p class="ix-order-note">{{ $t('intafaced.exchange.copy.placeLead') }}</p>
          <div class="ix-field">
            <label for="ix-copy-place-follow">{{ $t('intafaced.exchange.copy.followId') }}</label>
            <div class="ix-field-control">
              <input id="ix-copy-place-follow" type="text" spellcheck="false" autocomplete="off" v-model="copyPlaceFollowId" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-place-fill">{{ $t('intafaced.exchange.copy.fillId') }}</label>
            <div class="ix-field-control">
              <input id="ix-copy-place-fill" type="text" spellcheck="false" autocomplete="off" v-model="copyPlaceFillId" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-place-market">{{ $t('intafaced.exchange.copy.markets') }}</label>
            <div class="ix-field-control">
              <input id="ix-copy-place-market" type="text" spellcheck="false" autocomplete="off" v-model="copyPlaceMarketId" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-place-qty">{{ $t('intafaced.exchange.copy.qty') }}</label>
            <div class="ix-field-control">
              <input id="ix-copy-place-qty" type="text" inputmode="decimal" spellcheck="false" v-model="copyPlaceQty" @input="copyError = ''" />
            </div>
          </div>
          <div class="ix-field">
            <label for="ix-copy-place-notional">{{ $t('intafaced.exchange.copy.notional') }}</label>
            <div class="ix-field-control">
              <input id="ix-copy-place-notional" type="text" inputmode="decimal" spellcheck="false" v-model="copyPlaceNotional" @input="copyError = ''" />
            </div>
          </div>
          <button type="button" class="ix-submit is-buy" :disabled="!isLogin || copyPlacing" @click="placeCopyMirror">
            {{ copyPlacing ? $t('intafaced.exchange.copy.placing') : $t('intafaced.exchange.copy.placeMirror') }}
          </button>
        </div>

        <template v-else>
        <section v-if="ticketMarketUnavailable" class="ix-ticket-refusal" role="status">
          <strong>Order entry refused</strong>
          <span>Market feed and depth book are unavailable. This ticket cannot send an order.</span>
        </section>
        <div class="ix-side-toggle" role="group" aria-label="Order side" v-if="orderType !== 'tpsl'">
          <button
            type="button"
            :class="{ 'is-active': side === 'BUY' }"
            :aria-pressed="side === 'BUY' ? 'true' : 'false'"
            :disabled="advancedPlanLocked"
            @click="setSide('BUY')"
          >{{ $t("exchange.terminal.buy") }}</button>
          <button
            type="button"
            :class="{ 'is-active': side === 'SELL' }"
            :aria-pressed="side === 'SELL' ? 'true' : 'false'"
            :disabled="advancedPlanLocked"
            @click="setSide('SELL')"
          >{{ $t("exchange.terminal.sell") }}</button>
        </div>

        <nav class="ix-tabs ix-tabs-sm ix-type-tabs" aria-label="Order type" aria-describedby="ix-ticket-strip-note">
          <span class="ix-ticket-strip-label">Order types <em v-if="advancedPlanLocked">Controls locked</em></span>
          <button
            type="button"
            :class="{ 'is-active': orderType === 'LIMIT_PRICE' && !ticketCapability }"
            :aria-pressed="orderType === 'LIMIT_PRICE' && !ticketCapability ? 'true' : 'false'"
            :disabled="advancedPlanLocked"
            @click="setOrderType('LIMIT_PRICE')"
          >{{ $t("exchange.terminal.typeLimit") }}</button>
          <button
            type="button"
            :class="{ 'is-active': orderType === 'MARKET_PRICE' }"
            :aria-pressed="orderType === 'MARKET_PRICE' ? 'true' : 'false'"
            :disabled="advancedPlanLocked"
            @click="setOrderType('MARKET_PRICE')"
          >{{ $t("exchange.terminal.typeMarket") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'stop' }" @click="setOrderType('stop')">{{ $t("exchange.hlplus.stop") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'stop_limit' }" @click="setOrderType('stop_limit')">{{ $t("exchange.hlplus.stopLimit") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'trailing_stop' }" @click="setOrderType('trailing_stop')">{{ $t("exchange.hlplus.trailingStop") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'take_profit' }" @click="setOrderType('take_profit')">{{ $t("exchange.hlplus.takeProfit") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'twap' }" @click="setOrderType('twap')">{{ $t("exchange.hlplus.twap") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'scale' }" @click="setOrderType('scale')">{{ $t("exchange.hlplus.scale") }}</button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': orderType === 'tpsl' }" @click="setOrderType('tpsl')">{{ $t("exchange.hlplus.attachedTpsl") }}</button>
          <span class="ix-ticket-strip-label">Instructions <em>select fields</em></span>
          <!-- PTX-M07-R04: these are selectors for the existing trade helpers,
               not new order implementations. setOrderType normalizes each
               helper door back to its real base LIMIT ticket. -->
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'aon' }" :aria-pressed="ticketCapability === 'aon' ? 'true' : 'false'" @click="setOrderType('aon')"><span>AON</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'bracket' }" :aria-pressed="ticketCapability === 'bracket' ? 'true' : 'false'" @click="setOrderType('bracket')"><span>Bracket</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'close' }" :aria-pressed="ticketCapability === 'close' ? 'true' : 'false'" @click="setOrderType('close')"><span>Close</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'collar' }" :aria-pressed="ticketCapability === 'collar' ? 'true' : 'false'" @click="setOrderType('collar')"><span>Collar</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'GTD' }" :aria-pressed="ticketCapability === 'GTD' ? 'true' : 'false'" @click="setOrderType('GTD')"><span>GTD</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'iceberg' }" :aria-pressed="ticketCapability === 'iceberg' ? 'true' : 'false'" @click="setOrderType('iceberg')"><span>Iceberg</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" :disabled="advancedPlanLocked" :class="{ 'is-active': ticketCapability === 'oco' }" :aria-pressed="ticketCapability === 'oco' ? 'true' : 'false'" @click="setOrderType('oco')"><span>OCO</span> <span class="ix-capability-state">{{ advancedPlanLocked ? 'Locked' : 'Fields' }}</span></button>
          <button type="button" class="is-refused" :class="{ 'is-active': ticketCapability === 'peg' }" :aria-pressed="ticketCapability === 'peg' ? 'true' : 'false'" @click="setOrderType('peg')"><span>Peg</span> <span class="ix-capability-state">Refused</span></button>
          <button type="button" class="is-refused" :class="{ 'is-active': ticketCapability === 'rfq' }" :aria-pressed="ticketCapability === 'rfq' ? 'true' : 'false'" @click="setOrderType('rfq')"><span>{{ $t('exchange.residual.rfqOff') }}</span> <span class="ix-capability-state">Refused</span></button>
        </nav>
        <p id="ix-ticket-strip-note" class="ix-ticket-strip-note">{{ advancedPlanLocked ? $t('exchange.hlplus.partialPlanLocked') : 'Selecting fields does not place an order.' }}</p>

        <div
          class="ix-order-body"
          :class="[
            { 'is-more-open': ticketMoreOpen, 'is-capability-selected': ticketCapability },
            ticketCapability ? 'is-capability-' + ticketCapability.toLowerCase() : ''
          ]"
        >
          <section v-if="ticketCapability === 'peg'" class="ix-ticket-refusal ix-ticket-door-refusal" role="status">
            <strong>Peg orders unavailable</strong>
            <span>No reference-price contract is available. The ticket will not invent a mid or silently place a limit order.</span>
          </section>
          <section v-if="ticketCapability === 'rfq'" class="ix-ticket-refusal ix-ticket-door-refusal" role="status">
            <strong>{{ $t('exchange.residual.rfqUnavailable') }}</strong>
            <span>{{ $t('exchange.residual.rfqRefuse') }}</span>
          </section>
          <!-- A-UI-A11Y / B10 GOV.UK error-summary: focus lands here; text matches field error -->
          <div
            v-if="orderErrorSummary"
            :id="orderErrorSummary.id"
            ref="orderErrorSummary"
            class="ix-error-summary"
            role="alert"
            tabindex="-1"
          >
            <p class="ix-error-summary-title">{{ orderErrorSummary.title }}</p>
            <ul class="ix-error-summary-list">
              <li>
                <a
                  v-if="orderErrorSummary.href"
                  class="ix-error-summary-link"
                  :href="orderErrorSummary.href"
                  @click.prevent="focusTicketErrorField"
                >{{ orderErrorSummary.message }}</a>
                <span v-else>{{ orderErrorSummary.message }}</span>
              </li>
            </ul>
          </div>

          <!-- An unresolved write is a command outcome, not a generic error.
               Keep the ticket blocked until read-side reconciliation proves
               what happened. -->
          <div v-if="pendingOutcome" class="ix-outcome-banner" role="status" aria-live="polite">
            <strong>{{ outcomeTitle(pendingOutcome) }}</strong>
            <span>{{ outcomeMessage(pendingOutcome) }}</span>
            <button
              type="button"
              class="ix-linkish"
              :disabled="reconcilingOutcome"
              @click="reconcilePendingOutcome"
            >{{ reconcilingOutcome ? $t('exchange.residual.reconciling') : $t('exchange.residual.reconcileNow') }}</button>
          </div>

          <div v-if="amendOrder" class="ix-order-note ix-amend-note" role="note">
            <strong>{{ $t('exchange.residual.amendMode') }}</strong>
            {{ isNativeAmend ? $t('exchange.residual.amendNativeCopy') : $t('exchange.residual.amendSagaCopy') }}
            <button type="button" class="ix-linkish" :disabled="submitting" @click="cancelAmend">
              {{ $t('exchange.residual.cancelAmend') }}
            </button>
          </div>

          <div class="ix-field" v-if="orderType !== 'twap' && orderType !== 'tpsl'">
            <label for="ix-ticket-price">{{ $t("exchange.terminal.fieldPrice") }}</label>
            <div class="ix-input" :class="{ 'is-disabled': !orderNeedsLimitPrice }">
              <input
                id="ix-ticket-price"
                ref="ticketPrice"
                type="text"
                inputmode="decimal"
                spellcheck="false"
                :disabled="!orderNeedsLimitPrice || advancedPlanLocked"
                :placeholder="!orderNeedsLimitPrice ? $t('exchange.terminal.bestAvailable') : ''"
                :aria-invalid="ticketPriceAria['aria-invalid']"
                :aria-describedby="ticketPriceAria['aria-describedby']"
                v-model="form.price"
                @input="onPriceInput"
                @keydown.enter.prevent="submitOrder"
              />
              <span class="ix-unit">{{ currentCoin.base }}</span>
            </div>
          </div>

          <template v-if="orderType === 'scale'">
            <div class="ix-field">
              <label for="ix-ticket-scale-end">{{ $t('exchange.hlplus.scaleEndPrice') }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-scale-end"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  v-model="scaleEndPrice"
                  :disabled="advancedPlanLocked"
                  @input="onScaleEndPriceInput"
                  @keydown.enter.prevent="submitOrder"
                />
                <span class="ix-unit">{{ currentCoin.base }}</span>
              </div>
            </div>
            <div class="ix-field">
              <label for="ix-ticket-scale-count">{{ $t('exchange.hlplus.scaleOrderCount') }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-scale-count"
                  type="text"
                  inputmode="numeric"
                  spellcheck="false"
                  v-model="scaleOrderCount"
                  :disabled="advancedPlanLocked"
                  @input="clearPendingScaleIdentity"
                  @keydown.enter.prevent="submitOrder"
                />
              </div>
              <p class="ix-order-note">{{ $t('exchange.hlplus.scaleCountRange') }}</p>
            </div>
          </template>

          <template v-if="orderType === 'tpsl'">
            <p class="ix-order-note" v-if="attachedPosition">
              {{ $t('exchange.hlplus.attachedPosition', { id: attachedPosition.id, side: positionSideLabel(attachedPosition.side), size: attachedPosition.contracts }) }}
            </p>
            <div class="ix-field">
              <label for="ix-ticket-take-profit">{{ $t('exchange.hlplus.takeProfitTrigger') }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-take-profit"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  v-model="attachedTakeProfit"
                  :disabled="advancedPlanLocked"
                  @input="onAttachedTriggerInput('take')"
                  @keydown.enter.prevent="submitOrder"
                />
                <span class="ix-unit">{{ currentCoin.base }}</span>
              </div>
            </div>
            <div class="ix-field">
              <label for="ix-ticket-stop-loss">{{ $t('exchange.hlplus.stopLossTrigger') }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-stop-loss"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  v-model="attachedStopLoss"
                  :disabled="advancedPlanLocked"
                  @input="onAttachedTriggerInput('stop')"
                  @keydown.enter.prevent="submitOrder"
                />
                <span class="ix-unit">{{ currentCoin.base }}</span>
              </div>
            </div>
          </template>

          <div class="ix-field" v-if="orderType === 'twap'">
            <label for="ix-ticket-twap-duration">{{ $t('exchange.hlplus.twapDurationSeconds') }}</label>
            <div class="ix-input">
              <input
                id="ix-ticket-twap-duration"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                v-model="twapDurationSeconds"
                @input="clearPendingAlgoIdentity"
                @keydown.enter.prevent="submitOrder"
              />
            </div>
            <p class="ix-order-note">{{ $t('exchange.hlplus.twapMinimum') }}</p>
          </div>

          <template v-if="orderType === 'trailing_stop'">
            <div class="ix-field">
              <label for="ix-ticket-trail">{{ $t("exchange.hlplus.trailDistance") }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-trail"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  v-model="form.trail"
                  :disabled="advancedPlanLocked"
                  @input="onTrailInput"
                  @keydown.enter.prevent="submitOrder"
                />
                <span class="ix-unit">{{ currentCoin.base }}</span>
              </div>
            </div>
            <div class="ix-field">
              <label for="ix-ticket-mark">{{ $t("exchange.hlplus.trailMark") }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-mark"
                  type="text"
                  inputmode="decimal"
                  spellcheck="false"
                  v-model="form.mark"
                  :disabled="advancedPlanLocked"
                  @input="onMarkInput"
                  @keydown.enter.prevent="submitOrder"
                />
                <span class="ix-unit">{{ currentCoin.base }}</span>
              </div>
              <p class="ix-order-note">{{ $t("exchange.hlplus.trailingStopNote") }}</p>
            </div>
          </template>

          <div class="ix-field" v-if="orderNeedsStopPrice">
            <label for="ix-ticket-stop-price">{{ $t("exchange.hlplus.triggerPrice") }}</label>
            <div class="ix-input">
              <input
                id="ix-ticket-stop-price"
                type="text"
                inputmode="decimal"
                spellcheck="false"
                v-model="form.stopPrice"
                @input="onStopPriceInput"
                @keydown.enter.prevent="submitOrder"
              />
              <span class="ix-unit">{{ currentCoin.base }}</span>
            </div>
          </div>

          <div class="ix-field ix-hlplus-options" v-if="orderType !== 'twap' && orderType !== 'tpsl'">
            <label for="ix-ticket-tif">{{ $t("exchange.hlplus.timeInForce") }}</label>
            <select id="ix-ticket-tif" v-model="timeInForce" :disabled="wireOrderType === 'market' || advancedPlanLocked" @change="clearOrderSubmissionIdentity">
              <option value="GTC">GTC</option>
              <option value="IOC">IOC</option>
              <option value="FOK">FOK</option>
              <option value="PO">{{ $t("exchange.hlplus.postOnly") }}</option>
            </select>
          </div>

          <button
            v-if="orderType !== 'twap' && orderType !== 'tpsl'"
            type="button"
            class="ix-ticket-more-toggle"
            :aria-expanded="ticketMoreOpen ? 'true' : 'false'"
            aria-controls="ix-ticket-more"
            @click="ticketMoreOpen = !ticketMoreOpen"
          >{{ $t('exchange.residual.more') }} <span aria-hidden="true">{{ ticketMoreOpen ? '−' : '+' }}</span></button>

          <div
            v-if="orderType !== 'twap' && orderType !== 'tpsl'"
            v-show="ticketMoreOpen"
            id="ix-ticket-more"
            class="ix-ticket-more"
          >
            <label><input type="checkbox" v-model="postOnly" :disabled="wireOrderType === 'market' || advancedPlanLocked" @change="clearOrderSubmissionIdentity" /> {{ $t("exchange.hlplus.postOnly") }}</label>
            <label><input type="checkbox" v-model="reduceOnly" :disabled="advancedPlanLocked" @change="onReduceOnlyChange" /> {{ $t("exchange.hlplus.reduceOnly") }}</label>
          </div>

          <!-- ix-collar-ticket intentionally owns validation/wire binding but
               had no DOM installer. These text fields are caller-authored
               decimal strings; no price or band is derived in the browser. -->
          <section v-show="ticketMoreOpen && ticketCapability === 'collar'" id="ix-ticket-collar-wrap" class="ix-field ix-ticket-capability-fields">
            <label for="ix-ticket-collar">Price collar</label>
            <div class="ix-input ix-ticket-check">
              <input id="ix-ticket-collar" type="checkbox" aria-label="Apply caller price collar" />
            </div>
            <label for="ix-ticket-collar-min">Minimum price</label>
            <div class="ix-input">
              <input id="ix-ticket-collar-min" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" aria-label="Caller collar minimum price" />
            </div>
            <label for="ix-ticket-collar-max">Maximum price</label>
            <div class="ix-input">
              <input id="ix-ticket-collar-max" type="text" inputmode="decimal" spellcheck="false" autocomplete="off" aria-label="Caller collar maximum price" />
            </div>
            <p class="ix-order-note">Both caller bounds are required. Trade does not invent last or mid.</p>
          </section>

          <section v-if="spotCodVisible" class="ix-field" aria-label="Cancel on disconnect">
            <label>{{ $t('exchange.hlplus.codTitle') }}</label>
            <div class="ix-field">
              <label for="ix-ticket-cod-ttl">{{ $t('exchange.hlplus.codTtl') }}</label>
              <div class="ix-input">
                <input
                  id="ix-ticket-cod-ttl"
                  type="text"
                  inputmode="numeric"
                  spellcheck="false"
                  autocomplete="off"
                  v-model="codTtlMs"
                />
              </div>
            </div>
            <div class="ix-field ix-hlplus-options">
              <label for="ix-ticket-cod-scope">{{ $t('exchange.hlplus.codScope') }}</label>
              <select id="ix-ticket-cod-scope" v-model="codScope">
                <option value="account">account</option>
                <option value="session">session</option>
                <option value="market">market</option>
              </select>
            </div>
            <p class="ix-order-note" v-if="codScope === 'session'">{{ $t('exchange.hlplus.codSessionUnknown') }}</p>
            <button type="button" class="ix-linkish" :disabled="!isLogin" @click="armCod">{{ $t('exchange.hlplus.codArm') }}</button>
            <button type="button" class="ix-linkish" :disabled="!isLogin || !codView.armed" @click="renewCod">{{ $t('exchange.hlplus.codRenew') }}</button>
            <button type="button" class="ix-linkish" :disabled="!isLogin || !codView.armed" @click="disarmCod">{{ $t('exchange.hlplus.codDisarm') }}</button>
            <div class="ix-meta" v-if="codView.receivedAt">
              <div><dt>{{ $t('exchange.hlplus.codReceipt') }}</dt><dd>{{ codView.receivedAt }}</dd></div>
              <div><dt>{{ $t('exchange.hlplus.codExpiry') }}</dt><dd>{{ codView.expiresAt }}</dd></div>
            </div>
            <p class="ix-order-note" v-if="codView.lastCode === 'cod.lease_range_unconfigured'">{{ $t('exchange.hlplus.codUnconfigured') }}</p>
            <p class="ix-order-note" v-else-if="codView.lastCompletionReason === 'cod.disconnect_unconfirmed'">{{ $t('exchange.hlplus.codDisconnectUnknown') }}</p>
            <p class="ix-order-note" v-else-if="codView.lastCompletion">
              {{ codView.lastCompletion }} · {{ codView.lastCompletionCommandId }} · {{ codView.lastCompletionScope
              }}<span v-if="codView.lastCompletionMarketId"> · {{ codView.lastCompletionMarketId }}</span>
            </p>
          </section>

          <div class="ix-meta" v-if="twapParent">
            <div><dt>{{ $t('exchange.hlplus.twapParentId') }}</dt><dd>{{ twapParent.id }}</dd></div>
            <div><dt>{{ $t('exchange.hlplus.positionStatus') }}</dt><dd>{{ twapParent.status }}</dd></div>
            <div><dt>{{ $t('exchange.hlplus.twapNextSlice') }}</dt><dd>{{ twapParent.nextDueAt || '—' }}</dd></div>
          </div>

          <div class="ix-field">
            <label for="ix-ticket-amount">{{ amountLabel }}</label>
            <div class="ix-input">
              <input
                id="ix-ticket-amount"
                ref="ticketAmount"
                type="text"
                inputmode="decimal"
                spellcheck="false"
                placeholder=""
                :disabled="advancedPlanLocked"
                :aria-invalid="ticketAmountAria['aria-invalid']"
                :aria-describedby="ticketAmountAria['aria-describedby']"
                v-model="form.amount"
                @input="onAmountInput"
                @keydown.enter.prevent="submitOrder"
              />
              <span class="ix-unit">{{ amountUnit }}</span>
            </div>
          </div>

          <div class="ix-field" v-if="positionPreviewRequired">
            <label for="ix-ticket-leverage">{{ $t('exchange.hlplus.leverage') }}</label>
            <div class="ix-input">
              <input
                id="ix-ticket-leverage"
                type="text"
                inputmode="decimal"
                spellcheck="false"
                v-model="positionLeverage"
                :placeholder="$t('exchange.hlplus.leverageNoDefault')"
                @input="onPositionLeverageInput"
                @keydown.enter.prevent="submitOrder"
              />
              <span class="ix-unit">×</span>
            </div>
            <p class="ix-order-note">{{ $t('exchange.hlplus.isolatedOnly') }}</p>
          </div>

          <section v-if="isPerpKind" class="ix-m08-m10" aria-label="Margin modes and dated futures">
            <p
              v-for="row in perpTruthRows"
              :key="row.id"
              :class="row.availability === 'unavailable' ? 'ix-empty ix-empty-error' : 'ix-order-note'"
            >{{ row.availability === 'unavailable' ? row.reason : row.label }}</p>
          </section>

          <div class="ix-slider" v-if="orderType !== 'tpsl'">
            <input
              type="range"
              aria-label="Order size percentage"
              min="0"
              max="100"
              step="1"
              v-model.number="percent"
              :disabled="!canSize"
              @input="applyPercent"
            />
            <div class="ix-slider-steps">
              <button
                type="button"
                v-for="p in [25, 50, 75, 100]"
                :key="p"
                :class="{ 'is-active': percent === p }"
                :disabled="!canSize"
                @click="setPercent(p)"
              >{{ p }}%</button>
            </div>
          </div>

          <dl class="ix-meta">
            <template v-if="positionPreviewRequired">
              <div>
                <dt>{{ $t('exchange.hlplus.previewMark') }}</dt>
                <dd>
                  {{ positionPreviewValue(positionPreview && positionPreview.markPrice) }}
                  <em v-if="positionPreviewMarkSourceLabel">{{ positionPreviewMarkSourceLabel }}</em>
                </dd>
              </div>
              <div>
                <dt>{{ $t('exchange.hlplus.previewLeverageCap') }}</dt>
                <dd>{{ positionPreviewValue(positionPreview && positionPreview.leverageCap) }}</dd>
              </div>
              <div>
                <dt>{{ $t('exchange.hlplus.previewOrderValue') }}</dt>
                <dd>{{ positionPreviewValue(positionPreview && positionPreview.orderValue) }}</dd>
              </div>
              <div>
                <dt>{{ $t('exchange.hlplus.previewInitialMargin') }}</dt>
                <dd>{{ positionPreviewValue(positionPreview && positionPreview.initialMargin) }}</dd>
              </div>
              <div>
                <dt>{{ $t('exchange.hlplus.previewEstimatedFee') }}</dt>
                <dd>{{ positionPreviewValue(positionPreview && positionPreview.estimatedFee) }}</dd>
              </div>
              <div>
                <dt>{{ $t('exchange.hlplus.previewLiquidation') }}</dt>
                <dd>{{ positionPreviewValue(positionPreview && positionPreview.liquidationPrice) }}</dd>
              </div>
            </template>
            <template v-if="spotOrderPreviewRequired">
              <div>
                <dt>{{ $t('exchange.residual.spotPreviewHold') }}</dt>
                <dd>
                  {{ positionPreviewValue(spotOrderPreview && spotOrderPreview.holdAmount) }}
                  <em v-if="spotOrderPreview && spotOrderPreview.holdAsset">{{ spotOrderPreview.holdAsset }}</em>
                </dd>
              </div>
              <div>
                <dt>{{ $t('exchange.residual.spotPreviewFee') }}</dt>
                <dd>
                  {{ positionPreviewValue(spotOrderPreview && spotOrderPreview.estimatedFee) }}
                  <em v-if="spotOrderPreview && spotOrderPreview.feeAsset">{{ spotOrderPreview.feeAsset }}</em>
                  <em v-if="spotOrderPreview && spotOrderPreview.feeRole" class="ix-dim">{{ spotOrderPreview.feeRole }}</em>
                </dd>
              </div>
              <div v-if="spotOrderPreview && spotOrderPreview.protectionPrice !== null">
                <dt>{{ $t('exchange.residual.spotPreviewProtection') }}</dt>
                <dd>{{ positionPreviewValue(spotOrderPreview.protectionPrice) }}</dd>
              </div>
            </template>
            <div v-if="orderType !== 'tpsl'">
              <dt>{{ $t("exchange.terminal.available") }} <em class="ix-dim">(ledger)</em></dt>
              <!-- Three distinct states. `availableBalance` is null when the
                   ledger holds no row for this asset, which is neither "unknown"
                   nor "zero" — it is "you do not hold this". -->
              <dd v-if="!isLogin" class="ix-dim">— <em>{{ $t("exchange.residual.noPlatformSession") }}</em></dd>
              <dd v-else-if="!walletReachable" class="ix-dim">— <em>{{ $t("exchange.residual.unknownLedger") }}</em></dd>
              <dd v-else-if="availableBalance === null" class="ix-dim">
                0 <em>{{ side === 'BUY' ? currentCoin.base : currentCoin.coin }} {{ $t("exchange.residual.noLedgerRow") }}</em>
              </dd>
              <dd v-else>
                {{ availableBalance }}
                <em>{{ side === 'BUY' ? currentCoin.base : currentCoin.coin }}</em>
              </dd>
            </div>
            <div v-if="orderNeedsLimitPrice">
              <dt>{{ $t("exchange.terminal.orderValue") }}</dt>
              <dd>{{ fmt(orderValue, baseCoinScale) }} <em>{{ currentCoin.base }}</em></dd>
            </div>
            <div class="ix-fee-row" v-if="!spotOrderPreviewRequired">
              <dt>
                {{ $t("exchange.terminal.feeEst") }}
                <button
                  type="button"
                  class="ix-fee-help"
                  :aria-expanded="feeHelpOpen ? 'true' : 'false'"
                  aria-controls="ix-fee-help"
                  @click="feeHelpOpen = !feeHelpOpen"
                >?</button>
              </dt>
              <dd>{{ feeLabel }}</dd>
              <p
                v-if="feeHelpOpen"
                id="ix-fee-help"
                class="ix-fee-disclosure"
                role="note"
              >
                <template v-if="feeKnown">
                  {{ $t("exchange.residual.pairFeeFrom") }}
                  <strong>{{ currentCoin.coin }}/{{ currentCoin.base }}</strong>
                  — {{ pctOf(symbolFee, 4) }}% {{ $t("exchange.residual.scheduleRateNotFree") }}
                </template>
                <template v-else>
                  {{ $t("exchange.residual.feeFieldMissing") }}
                  <strong>unknown</strong>{{ $t("exchange.residual.feeFieldMissingTail") }}
                </template>
              </p>
            </div>
            <div v-if="orderType === 'MARKET_PRICE' && marketImpactLabel">
              <dt>{{ $t("exchange.residual.bookImpact") }} <em class="ix-dim">(est.)</em></dt>
              <dd>{{ marketImpactLabel }}</dd>
            </div>
          </dl>

          <p class="ix-order-note" v-if="positionPreviewRequired && positionPreviewLoading">
            {{ $t('exchange.hlplus.previewLoading') }}
          </p>
          <p class="ix-order-note ix-order-error" v-else-if="positionPreviewRequired && positionPreviewMessage">
            {{ positionPreviewMessage }}
          </p>
          <ul class="ix-order-note ix-order-error" v-if="positionPreviewRequired && positionPreview && positionPreview.refusals.length">
            <li v-for="row in positionPreview.refusals" :key="row.code + ':' + row.field">{{ row.message }}</li>
          </ul>
          <p class="ix-order-note" v-if="spotOrderPreviewRequired && spotOrderPreviewLoading">
            {{ $t('exchange.residual.spotPreviewLoading') }}
          </p>
          <p class="ix-order-note ix-order-error" v-else-if="spotOrderPreviewRequired && spotOrderPreviewMessage">
            {{ spotOrderPreviewMessage }}
          </p>
          <ul class="ix-order-note ix-order-error" v-if="spotOrderPreviewRequired && spotOrderPreview && spotOrderPreview.refusals.length">
            <li v-for="row in spotOrderPreview.refusals" :key="row.code + ':' + row.field">{{ row.message }}</li>
          </ul>

          <button
            type="button"
            class="ix-submit"
            :class="orderType === 'tpsl' && attachedPosition ? (attachedPosition.side === 'long' ? 'is-sell' : 'is-buy') : (side === 'BUY' ? 'is-buy' : 'is-sell')"
            :disabled="!tradable || submitting || !!orderBlockReason || !!pendingOutcome"
            :aria-busy="submitting ? 'true' : 'false'"
            @click="submitOrder"
          >
            {{ submitting ? $t('exchange.terminal.placing') : submitLabel }}
          </button>

          <section v-if="batchEligible && ticketMoreOpen" class="ix-batch-box" aria-label="Batch order staging">
            <p class="ix-order-note ix-batch-lead">{{ $t('exchange.residual.batchLead', { max: batchMax }) }}</p>
            <div class="ix-batch-actions">
              <button
                type="button"
                class="ix-submit is-buy"
                :disabled="batchStageDisabled"
                @click="stageCurrentBatchOrder"
              >{{ $t('exchange.residual.stageBatchOrder') }}</button>
              <button
                type="button"
                class="ix-submit"
                :disabled="!batchStagedCount || submitting || !!pendingOutcome"
                @click="submitBatchOrders"
              >{{ $t('exchange.residual.submitBatchOrders', { count: batchStagedCount }) }}</button>
            </div>
            <p class="ix-order-note ix-dim">{{ $t('exchange.residual.batchSequential') }}</p>
            <ol v-if="stagedBatchOrders.length" class="ix-batch-list">
              <li v-for="(draft, index) in stagedBatchOrders" :key="draft.clientOrderId || index">
                <code>{{ draft.clientOrderId }}</code>
                <span :class="draft.status === 'unknown' ? 'ix-outcome-unknown' : 'ix-dim'">{{ batchDraftStatus(draft) }}</span>
                <button
                  v-if="draft.status === 'staged' || draft.status === 'refused'"
                  type="button"
                  class="ix-linkish"
                  @click="removeBatchDraft(index)"
                >{{ $t('exchange.residual.removeBatchDraft') }}</button>
                <button
                  v-else-if="draft.status === 'unknown'"
                  type="button"
                  class="ix-linkish"
                  @click="abandonBatchDraft(index)"
                >{{ $t('exchange.residual.abandonBatchUnknown') }}</button>
              </li>
            </ol>
            <ol v-if="batchResults.length" class="ix-batch-results" aria-label="Batch order results">
              <li v-for="result in batchResults" :key="'result-' + result.clientOrderId">
                <code>{{ result.clientOrderId }}</code>
                <span :class="result.status === 'unknown' ? 'ix-outcome-unknown' : ''">{{ result.status }}</span>
              </li>
            </ol>
            <p v-if="batchMessage" class="ix-order-note ix-order-error" role="status">{{ batchMessage }}</p>
          </section>

          <section v-if="batchAmendVisible" class="ix-batch-box" aria-label="Batch native amend staging">
            <p class="ix-order-note ix-batch-lead">{{ $t('exchange.residual.batchAmendLead', { max: batchAmendMax }) }}</p>
            <p class="ix-order-note ix-dim" v-if="amendOrder && !isNativeAmend">{{ $t('exchange.residual.batchAmendNativeOnly') }}</p>
            <div class="ix-batch-actions">
              <button
                type="button"
                class="ix-submit is-buy"
                :disabled="batchAmendStageDisabled"
                @click="stageCurrentBatchAmend"
              >{{ $t('exchange.residual.stageBatchAmend') }}</button>
              <button
                type="button"
                class="ix-submit"
                :disabled="!batchAmendStagedCount || submitting || !!pendingOutcome"
                @click="submitBatchAmends"
              >{{ $t('exchange.residual.submitBatchAmends', { count: batchAmendStagedCount }) }}</button>
            </div>
            <p class="ix-order-note ix-dim">{{ $t('exchange.residual.batchSequential') }}</p>
            <ol v-if="stagedBatchAmends.length" class="ix-batch-list">
              <li v-for="(draft, index) in stagedBatchAmends" :key="draft.orderId || index">
                <code>{{ draft.orderId }}</code>
                <span class="ix-dim">{{ draft.qty }}</span>
                <span :class="draft.status === 'unknown' ? 'ix-outcome-unknown' : 'ix-dim'">{{ batchDraftStatus(draft) }}</span>
                <button
                  v-if="draft.status === 'staged' || draft.status === 'refused'"
                  type="button"
                  class="ix-linkish"
                  @click="removeBatchAmendDraft(index)"
                >{{ $t('exchange.residual.removeBatchDraft') }}</button>
                <button
                  v-else-if="draft.status === 'unknown'"
                  type="button"
                  class="ix-linkish"
                  @click="abandonBatchAmendDraft(index)"
                >{{ $t('exchange.residual.abandonBatchUnknown') }}</button>
              </li>
            </ol>
            <ol v-if="batchAmendResults.length" class="ix-batch-results" aria-label="Batch amend results">
              <li v-for="result in batchAmendResults" :key="'amend-result-' + result.orderId">
                <code>{{ result.orderId }}</code>
                <span :class="result.status === 'unknown' ? 'ix-outcome-unknown' : ''">{{ result.status }}</span>
              </li>
            </ol>
            <p v-if="batchAmendMessage" class="ix-order-note ix-order-error" role="status">{{ batchAmendMessage }}</p>
          </section>
          <p class="ix-order-note ix-dim ix-kbd-hint" :title="$t('exchange.residual.keyboardShortcuts')">
            <kbd>/</kbd> markets · <kbd>{{ $t("shellResidual.esc") }}</kbd> clear · <kbd>B</kbd>/<kbd>S</kbd> buy/sell · <kbd>T</kbd> ticket · <kbd>{{ $t("shellResidual.enter") }}</kbd> submit · <kbd>X</kbd> {{ $t("exchange.residual.cancelLast") }} · <kbd>⌘</kbd>/<kbd>{{ $t("exchange.residual.ctrl") }}</kbd>+<kbd>K</kbd> go
          </p>
          <!-- Inline echo kept in sync with summary (GOV.UK: same wording); focus is on summary -->
          <p
            class="ix-order-note ix-order-error"
            aria-hidden="true"
            v-if="orderValidationError"
          >{{ orderValidationError }}</p>
          <p class="ix-order-note" v-if="!isLogin">
            <router-link to="/login">{{ $t("exchange.terminal.signIn") }}</router-link> or
            <router-link to="/register">{{ $t("exchange.terminal.register") }}</router-link> {{ $t("exchange.terminal.toTrade") }}
          </p>
          <p class="ix-order-note" v-else-if="exchangeable != 1">{{ $t("exchange.terminal.halted") }}</p>
          <p class="ix-order-note" v-else-if="orderType === 'MARKET_PRICE' && !marketAllowed">
            {{ $t('exchange.terminal.marketDisabled', { side: side === 'BUY' ? $t('exchange.terminal.buyLower') : $t('exchange.terminal.sellLower') }) }}
          </p>
          <p class="ix-order-note" v-else-if="!feedLive">
            {{ $t("exchange.terminal.feedDownWarning") }}
          </p>
          <p class="ix-order-note" v-else-if="orderBlockReason">{{ orderBlockReason }}</p>
        </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<script>
/* ============================================================================
   INTAFACED — spot trading terminal
   ----------------------------------------------------------------------------
   THE AUTO-SCROLL BUG

   The vendor built the chart library widget with `fullscreen: true`. In
   the chart engine that flag drives:

       _autoResizeChart: function () {
         this.options.fullscreen && (gEl(this.id).style.height = window.innerHeight + 'px')
       }

   which runs on create and again from a `resize` listener on window. So the
   chart iframe was forced to the full viewport height inside a 350px
   `overflow: hidden` box: the visible slice was the top third of a chart laid
   out for a 900px canvas, and the rest — time axis, most of the candles —
   sat below the clip, i.e. scrolled off the screen. `fullscreen` also
   suppresses the `height: 100%` that `autosize` would otherwise set, so the
   iframe never tracked its container.

   Two things made it worse and are fixed here too:

     * getKline() ran inside the STOMP connect callback, and the callback fires
       again on every reconnect. Each call did `container.innerHTML = iframe`
       and registered ANOTHER window resize listener, none of which were ever
       removed (widget.remove() was never called). After a few reconnects
       several stale handlers were each re-stretching the iframe.
     * the depth chart's hover handler assigned `canvas.height = 500` on every
       mousemove, which resizes the canvas element itself. See DepthGraph.vue.

   The widget is now created once per symbol with `autosize: true` and no
   `fullscreen`, into a container with a definite height, and is torn down with
   widget.remove() before any re-create and on destroy.

   DEGRADATION

   Every request goes through request(), which resolves to null instead of
   rejecting. A backend that is down yields empty states, not a console full of
   unhandled rejections. The chart uses lightweight-charts (Apache-2.0) and
   loads history from /market/history; empty history draws an empty frame.
   ========================================================================== */
import { KlineChart } from '@js/market-chart/kline.js';
import DepthGraph from '@components/exchange/DepthGraph.vue';
import IxState from '@components/intafaced/IxState.vue';
import SubAccountSelector from '@components/intafaced/SubAccountSelector.vue';

import { rest, query, mutate, symbolPath, subjectOf, REST_BASE } from '@/config/intafaced.js';

var moment = require('moment');
var deskHotkeys = require('../../assets/js/desk-hotkeys.js');
var deskA11y = require('../../assets/js/desk-a11y.js');
var deskPrefs = require('../../assets/js/desk-prefs.js');
var bookHonesty = require('../../assets/js/book-honesty.js');
var ixMoney = require('../../assets/js/ix-money.js');
var ixMarketImpact = require('../../assets/js/ix-market-impact.js');
var ixDepthFeed = require('../../assets/js/ix-depth-feed.js');
var subAccounts = require('../../assets/js/sub-accounts.js');
var ixTrade = require('../../assets/js/ix-trade.js');
var ixOrderOutcome = require('../../assets/js/ix-order-outcome.js');
var ixOrderBlock = require('../../assets/js/ix-order-block.js');
var ixChannelStatus = require('../../assets/js/ix-channel-status.js');
var ixBatchOrder = require('../../assets/js/ix-batch-order.js');
var ixBatchAmend = require('../../assets/js/ix-batch-amend.js');
var ixCod = require('../../assets/js/ix-cod.js');
var ixDropCopy = require('../../assets/js/ix-drop-copy.js');
var ixBlotterTabs = require('../../assets/js/ix-blotter-tabs.js');
var ixDeskM08M10 = require('../../assets/js/ix-desk-m08-m10.js');
var positionPreviewWire = require('../../assets/js/position-preview.js');
var spotOrderPreviewWire = require('../../assets/js/spot-order-preview.js');
var deskVisibility = require('../../assets/js/desk-visibility-revalidate.js');
var ixDupTabLock = require('../../assets/js/ix-dup-tab-lock.js');

const BOOK_DEPTH = 14;
const TRADE_LIMIT = 40;
const DEPTH_REDRAW_MS = 1000;
/** Levels pulled for the depth chart — deeper than the ladder; API caps at 500. */
const DEPTH_LEVELS = 200;
const MAX_BATCH_ORDERS = ixBatchOrder.MAX_BATCH_ORDERS;
const MAX_BATCH_AMENDS = ixBatchAmend.MAX_BATCH_AMENDS;

export default {
  components: { DepthGraph, IxState, SubAccountSelector },
  data() {
    return {
      defaultPair: 'btc_usdt',

      currentCoin: { base: '', coin: '', symbol: '', close: 0, rose: '', high: 0, low: 0, volume: 0, expiryDatetime: null },
      currentCoinIsFavor: false,
      coinInfo: {},
      /* Decimal-place counts come from market.precision only (getSymbolScale).
         null = instrument has not published yet — fmt/group/clamp refuse invent. */
      coinScale: null,
      baseCoinScale: null,
      /* A fee RATE is money-shaped: a decimal string, never a float literal.
         Shown only when feeKnown — the ticket says "unknown", not "free". */
      symbolFee: '0.001',
      enableMarketBuy: 1,
      enableMarketSell: 1,
      exchangeable: 1,
      CNYRate: null,

      markets: [],
      marketMap: {},
      marketsOpen: false,
      baseFilter: 'USDT',
      searchKey: '',

      mainTab: 'chart',
      deskMode: 'spot',
      convertSide: 'buy',
      convertQty: '',
      convertQuote: null,
      convertResult: null,
      convertError: '',
      convertLoading: false,
      convertExecuting: false,
      copyLeaderId: '',
      copyRegion: '',
      copyPermittedMarkets: '',
      copyMaxNotionalPerOrder: '',
      copyMaxAggregateExposure: '',
      copyExpiresAt: '',
      copyFollows: [],
      copyFollowsLoading: false,
      copyFollowsReachable: false,
      copyFollowing: false,
      copyUnfollowingId: '',
      copyGrantingId: '',
      copyKillingId: '',
      copyPlacing: false,
      copyPlaceFollowId: '',
      copyPlaceFillId: '',
      copyPlaceMarketId: '',
      copyPlaceQty: '',
      copyPlaceNotional: '',
      copyError: '',
      copyActingId: '',
      mainTabs: [
        { id: 'chart', label: 'Chart' },
        { id: 'depth', label: 'Depth' },
        { id: 'book', label: 'Order Book' },
        { id: 'trades', label: 'Trades' }
      ],
      railTab: 'book',
      bookMode: 'all',
      bookModes: [
        { id: 'all', label: 'Bids and asks' },
        { id: 'bids', label: 'Bids only' },
        { id: 'asks', label: 'Asks only' }
      ],
      bookGroup: 1,
      bookGroups: [1, 10, 50, 100],
      accountTab: 'balances',

      interval: '60',
      intervals: [
        { label: '1m', value: '1' },
        { label: '5m', value: '5' },
        { label: '15m', value: '15' },
        { label: '30m', value: '30' },
        { label: '1H', value: '60' },
        { label: '1D', value: '1D' },
        { label: '1W', value: '1W' }
      ],
      chartFailed: false,
      feedLive: false,
      /* True only after market symbol-info returns a fee field. Default is not free. */
      feeKnown: false,
      /** B9 fee schedule disclosure open (ticket). */
      feeHelpOpen: false,
      /** Dense desk default: secondary order controls stay one deliberate click away. */
      ticketMoreOpen: false,
      /** LOOK-only selector for existing ix-*-ticket helpers; empty is the base ticket. */
      ticketCapability: '',

      marketsLoading: false,
      marketsReachable: false,
      /** True until first plate REST settles — loading ≠ unavailable. */
      bookLoading: true,
      bookReachable: false,
      /** IxState reason: null while loading, 'ok' for an answered book (incl. empty). */
      bookReason: null,
      /** True until first trades REST settles. */
      tradesLoading: true,
      tradesReachable: false,

      plate: { asks: [], bids: [], askTotal: null, bidTotal: null },
      trades: [],
      openOrders: [],
      /** All-market open orders for the explicit across-markets panic control. */
      allOpenOrders: [],
      historyOrders: [],
      /** Canonical Position[] from GET /api/v1/positions; decimal strings stay strings. */
      positions: [],
      positionsReachable: false,
      positionsMessage: '',
      futuresTicker: {
        markPrice: null,
        markSource: null,
        fundingRate: null,
        fundingPeriodId: null,
        nextFundingTime: null
      },
      futuresTickerMessage: '',
      /** Publisher-authored periods observed from the futures ticker; never clock-derived. */
      fundingHistory: [],
      fundingHistoryReachable: false,
      fundingHistoryMessage: '',
      /** Server-versioned ADL disclosure. No local-only acknowledgement is accepted. */
      adlDisclosure: { version: '', copy: '', acknowledged: false, acknowledgedAt: null },
      adlDisclosureLoading: false,
      /** B6 server-authored risk facts; never seeded from ticker/client math. */
      positionLeverage: '',
      positionPreview: null,
      positionPreviewLoading: false,
      positionPreviewMessage: '',
      /** Server-authored spot hold/fee; never seeded from ticket math. */
      spotOrderPreview: null,
      spotOrderPreviewLoading: false,
      spotOrderPreviewMessage: '',
      /** Fills from /account/trades. A separate call — orders carry no nested fills. */
      myFills: [],
      fillsReachable: false,
      /** Every ledger row for this user, from /account/balance. */
      balances: [],
      /**
       * Free balance for the two assets of THIS pair, or null.
       *
       * NULL, NOT 0. No ledger row means the ledger has never held that asset
       * for this user; a zero here would size an order against a balance we
       * invented. Every reader of this guards on null.
       */
      wallet: { base: null, coin: null },
      /** The venue's listing row for this pair (tick, lot, min notional, fees). */
      market: null,
      /** Watchlist symbols, local to this browser. Not account state. */
      localFavorites: [],
      /** Verbatim refusal text, kept so a panel can quote the venue. */
      bookMessage: '',
      tradesMessage: '',
      accountRefusal: '',
      /** 'ok' | 'empty' | 'failed' — see kline.js. */
      chartStatus: 'ok',
      chartProvenance: {
        status: 'loading',
        source: 'svc-trade REST snapshot',
        live: false,
        latestCandleTimeMs: null
      },
      chartAccessibleState: null,
      accountLoading: false,
      accountError: '',
      walletReachable: false,
      ordersReachable: false,
      openOrdersReachable: false,
      allOpenOrdersReachable: false,
      /** R10: true only when the workspace lock is explicitly on. Unset/false does not invent a lock. */
      orderEntryLocked: false,

      side: 'BUY',
      orderType: 'LIMIT_PRICE',
      timeInForce: 'GTC',
      postOnly: false,
      reduceOnly: false,
      /** Server-time COD lease. Empty ttl is refuse, never an invented default. */
      codTtlMs: '',
      codScope: 'account',
      codView: ixCod.emptyView(),
      dropCopyView: ixDropCopy.emptyView(),
      pendingClientOrderId: '',
      /** Other-tab in-flight submit; `{ ts, clientOrderId }` only — never a token. */
      dupTabLockHeld: null,
      /** Durable command evidence; never clear or retry blindly after timeout. */
      pendingOutcome: null,
      reconcilingOutcome: false,
      /** Local, immutable spot drafts; never an account balance or order book. */
      stagedBatchOrders: [],
      batchResults: [],
      pendingBatchOutcome: null,
      batchMessage: '',
      batchStateLoaded: false,
      stagedBatchAmends: [],
      batchAmendResults: [],
      batchAmendMessage: '',
      pendingBatchAmendOutcome: null,
      /** Existing open spot row being amended (native qty-down or cancel/replace). */
      amendOrder: null,
      pendingClientAlgoId: '',
      twapDurationSeconds: '',
      twapParent: null,
      scaleEndPrice: '',
      scaleOrderCount: '',
      pendingScaleOrders: [],
      batchAcceptedChildren: 0,
      attachedTakeProfit: '',
      attachedStopLoss: '',
      pendingBracketOrders: [],
      bracketAcceptedCount: 0,
      pendingBracketPositionId: '',
      percent: 0,
      form: { price: '', stopPrice: '', amount: '', trail: '', mark: '' },

      trend: 0,
      submitting: false,
      cancellingId: null,
      /** Scope of an in-flight cancel-all request, if any. */
      massCancelScope: null,
      /** Inline field validation message; empty when fields look usable. */
      orderValidationError: '',
      /** B10 — screen-reader announcements (order rejects, validation). */
      liveAnnounce: '',
      /** B5 — fixed column widths (px); centre flexes. Not money. */
      panelW: Object.assign({}, deskPrefs.PANEL_DEFAULTS),
      /** Wave C chart studies; local display state, computed only from accepted candle rows. */
      indicatorVisibility: Object.assign({}, deskPrefs.INDICATOR_DEFAULTS),
      /** Storage refusal/corruption is observable; layout still falls back safely. */
      layoutPrefsNotice: '',
      /** Viewport wide enough for four-column desk + resize handles. */
      panelResizeActive: true
    };
  },

  computed: {
    chartAccessibleSummary() {
      const candle = this.chartAccessibleState;
      if (!candle) return this.chartStatus === 'empty' ? 'No candles to inspect.' : 'Candle summary unavailable.';
      return 'Candle ' + candle.index + ' of ' + candle.total + ' · ' +
        moment(Number(candle.time) * 1000).utc().format('YYYY-MM-DD HH:mm [UTC]') +
        ' · open ' + candle.open + ' · high ' + candle.high + ' · low ' + candle.low + ' · close ' + candle.close;
    },
    chartProvenanceLabel() {
      const state = this.chartProvenance || {};
      if (state.status === 'loading') return 'svc-trade REST snapshot · loading';
      if (state.status === 'failed') return 'svc-trade REST snapshot · unavailable · stream ' + (state.transport || 'not connected');
      if (state.status === 'empty') return 'svc-trade REST snapshot · no candles · stream ' + (state.transport || 'not connected');
      if (state.status === 'ok' && state.latestCandleTimeMs) {
        return state.source + ' · latest candle ' + moment(state.latestCandleTimeMs).utc().format('YYYY-MM-DD HH:mm [UTC]') +
          ' · stream ' + (state.live ? 'live' : (state.transport || 'not connected'));
      }
      return 'svc-trade REST snapshot · freshness unknown · stream ' + (state.transport || 'not connected');
    },
    isPerpKind() {
      return !!(this.$route && this.$route.query && this.$route.query.kind === 'perp');
    },
    positionPreviewRequired() {
      return this.isPerpKind && this.orderType !== 'tpsl' && (this.orderType === 'twap' || !this.reduceOnly);
    },
    spotOrderPreviewRequired() {
      return this.deskMode === 'spot' && !this.isPerpKind && !this.amendOrder &&
        this.orderType !== 'twap' && this.orderType !== 'scale' && this.orderType !== 'tpsl';
    },
    spotCodVisible() {
      return this.deskMode === 'spot' && !this.isPerpKind;
    },
    futuresMarkSourceLabel() {
      if (this.futuresTicker.markSource === 'depth') return this.$t('exchange.hlplus.markSourceDepth');
      if (this.futuresTicker.markSource === 'venue') return this.$t('exchange.hlplus.markSourceVenue');
      return '';
    },
    positionPreviewMarkSourceLabel() {
      const source = this.positionPreview && this.positionPreview.markSource;
      if (source === 'depth') return this.$t('exchange.hlplus.markSourceDepth');
      if (source === 'venue') return this.$t('exchange.hlplus.markSourceVenue');
      return '';
    },
    fundingRateLabel() {
      return this.futuresTicker.fundingRate === null ? '—' : String(this.futuresTicker.fundingRate);
    },
    wireOrderType() {
      if (this.orderType === 'MARKET_PRICE') return 'market';
      if (this.orderType === 'LIMIT_PRICE') return 'limit';
      return this.orderType;
    },
    attachedPosition() {
      if (!this.isPerpKind || !this.positionsReachable) return null;
      const symbol = this.currentCoin && this.currentCoin.symbol;
      const rows = this.positions.filter(row => row.symbol === symbol && row.status === 'open');
      return rows.length === 1 ? rows[0] : null;
    },
    advancedPlanLocked() {
      return this.batchAcceptedChildren > 0 || this.bracketAcceptedCount > 0;
    },
    batchEligible() {
      return this.deskMode === 'spot' && !this.isPerpKind && !this.amendOrder &&
        (this.orderType === 'LIMIT_PRICE' || this.orderType === 'MARKET_PRICE');
    },
    batchMax() {
      return MAX_BATCH_ORDERS;
    },
    batchStageDisabled() {
      return !this.batchEligible || !this.tradable || !!this.orderBlockReason ||
        !!this.pendingOutcome || this.stagedBatchOrders.length >= MAX_BATCH_ORDERS;
    },
    batchStagedCount() {
      return this.stagedBatchOrders.filter(function (row) { return row.status === 'staged'; }).length;
    },
    batchUnknownCount() {
      return this.stagedBatchOrders.filter(function (row) { return row.status === 'unknown'; }).length;
    },
    batchAmendVisible() {
      return this.deskMode === 'spot' && !this.isPerpKind &&
        (!!this.amendOrder || this.stagedBatchAmends.length > 0);
    },
    batchAmendMax() {
      return MAX_BATCH_AMENDS;
    },
    batchAmendStagedCount() {
      return this.stagedBatchAmends.filter(function (row) { return row.status === 'staged'; }).length;
    },
    batchAmendStageDisabled() {
      return !this.amendOrder || !this.isNativeAmend || this.submitting || !!this.pendingOutcome ||
        this.stagedBatchAmends.length >= MAX_BATCH_AMENDS;
    },
    isMassCancelPending() {
      return !!(this.pendingOutcome && this.pendingOutcome.action === 'cancel_all');
    },
    amendTicket() {
      if (!this.amendOrder) return null;
      return {
        symbol: this.amendOrder.symbol || (this.currentCoin && this.currentCoin.symbol) || '',
        type: this.orderType,
        side: this.side,
        amount: String(this.form.amount).trim(),
        price: String(this.form.price).trim(),
        timeInForce: this.timeInForce,
        postOnly: this.postOnly === true || this.timeInForce === 'PO',
        clientOrderId: this.pendingClientOrderId
      };
    },
    amendRoute() {
      if (!this.amendOrder) return null;
      return ixTrade.amendRoute(this.amendOrder, this.amendTicket);
    },
    isNativeAmend() {
      return this.amendRoute === 'NATIVE_AMEND';
    },
    chartRepriceAvailable() {
      return !!(
        this.amendOrder &&
        this.chartStatus === 'ok' &&
        this.klineChart &&
        this.currentCoin &&
        this.currentCoin.tickSize &&
        ixMoney.isPositive(this.form.price)
      );
    },
    repriceDeltaLabel() {
      if (!this.amendOrder) return '—';
      return ixMoney.subtract(this.form.price, this.amendOrder.price) || '—';
    },
    repriceRemainingLabel() {
      if (!this.amendOrder) return '—';
      return ixMoney.subtract(this.amendOrder.amount, this.amendOrder.tradedAmount || '0') || '—';
    },
    /* A mass-cancel outcome stays durable, but a reader may still deliberately
       cancel one visible row while reconciling a target that remains open. */
    isIndividualActionBlocked() {
      return !!(this.pendingOutcome && this.pendingOutcome.action !== 'cancel_all');
    },
    orderNeedsLimitPrice() {
      return this.wireOrderType === 'limit' || this.wireOrderType === 'stop_limit' || this.wireOrderType === 'trailing_stop' || this.orderType === 'scale';
    },
    orderNeedsStopPrice() {
      return this.wireOrderType === 'stop' || this.wireOrderType === 'stop_limit' || this.wireOrderType === 'take_profit';
    },
    /* A-UI-A11Y / B10 — GOV.UK error-summary model (verbatim ticket error). */
    orderErrorSummary() {
      return deskA11y.buildTicketErrorSummary(this.orderValidationError);
    },
    ticketPriceAria() {
      return deskA11y.ticketFieldAria('price', this.orderValidationError);
    },
    ticketAmountAria() {
      return deskA11y.ticketFieldAria('amount', this.orderValidationError);
    },
    /** B5 — desktop grid only; narrow layouts keep CSS media queries. */
    deskBodyStyle() {
      if (!this.panelResizeActive) return {};
      var w = deskPrefs.normalizePanelWidths(this.panelW);
      return {
        '--ix-market-column-width': w.markets + 'px',
        '--ix-right-column-width': w.order + 'px'
      };
    },
    /** The platform session's access token, or null. In memory only. */
    ixToken() {
      return this.$store.getters.ixToken;
    },
    convertCanExecute() {
      if (!this.convertQuote || !this.convertQuote.expiresAt || !this.convertQty) return false;
      return Date.parse(this.convertQuote.expiresAt) > Date.now() &&
        String(this.convertQuote.requestedQty) === String(this.convertQty).trim();
    },
    /**
     * "SIGNED IN" ON THIS SCREEN MEANS THE PLATFORM SESSION, NOT THE SHELL ONE.
     *
     * This desk now talks only to svc-edge, and svc-edge only believes
     * `ixToken`. It used to read `$store.getters.isLogin`, which is the
     * vendored ucenter session — a completely separate login. Leaving it that
     * way would have been the worst combination available: a reader signed in
     * to the shell would get an enabled order ticket, a blotter that reads
     * "no open orders", and a 401 the moment they pressed Buy.
     *
     * The shell session still exists and still governs the shell's own screens.
     * It just cannot answer for anything on this page.
     */
    isLogin() {
      return !!this.ixToken;
    },
    member() {
      return this.$store.getters.member;
    },
    lastPrice() {
      const value = this.currentCoin.close;
      return ixMoney.toBN(value) === null ? null : String(value);
    },
    trendClass() {
      const direction = ixMoney.compare(this.currentCoin.chg, '0');
      return direction > 0 ? 'ix-up' : direction < 0 ? 'ix-down' : '';
    },
    fiatValue() {
      if (!this.CNYRate || !this.currentCoin.usdRate) {
        return '';
      }
      const converted = ixMoney.multiply(this.currentCoin.usdRate, this.CNYRate, 2);
      return converted === null ? '' : this.fmt(converted, 2);
    },
    /* Asks are held best-last so the rail can render them top-down away from
       the spread, the way every book on the market reads. */
    asks() {
      return this.groupPlate(this.plate.asks, 'ask').slice(-BOOK_DEPTH);
    },
    asksAscending() {
      return this.groupPlate(this.plate.asks, 'ask').slice().reverse();
    },
    bids() {
      return this.groupPlate(this.plate.bids, 'bid').slice(0, BOOK_DEPTH);
    },
    spread() {
      const askRow = this.plate.asks.length ? this.plate.asks[this.plate.asks.length - 1] : null;
      const bidRow = this.plate.bids.length ? this.plate.bids[0] : null;
      if (!askRow || !bidRow) return null;
      const diff = ixMoney.subtract(askRow.price, bidRow.price);
      if (diff === null || !ixMoney.isPositive(diff)) return null;
      return this.fmt(diff, this.baseCoinScale);
    },
    /**
     * Loading or a named refuse — IxState, not a ladder of zeros.
     * reason === 'ok' with empty sides is an answered empty book (slot, not 0).
     */
    bookStateNamed() {
      return this.bookLoading || (this.bookReason && this.bookReason !== 'ok');
    },
    bookEndpoint() {
      const sym = this.currentCoin && this.currentCoin.symbol;
      return REST_BASE + '/orderbook/' + (sym ? symbolPath(sym) : '');
    },
    visibleMarkets() {
      const key = this.searchKey.trim().toUpperCase();
      let rows;
      if (this.baseFilter === 'favor') {
        rows = this.markets.filter(r => r.isFavor);
      } else {
        rows = this.markets.filter(r => r.base === this.baseFilter);
      }
      if (key) {
        rows = rows.filter(r => (r.coin || '').indexOf(key) === 0);
      }
      return rows;
    },
    /* B6 — favourites for the pinned watchlist rail (density-capped). */
    watchlistMarkets() {
      const key = this.searchKey.trim().toUpperCase();
      let rows = this.markets.filter(r => r.isFavor);
      if (key) {
        rows = rows.filter(r => (r.coin || '').indexOf(key) === 0);
      }
      return rows.slice(0, 8);
    },
    /**
     * The Balances tab — every asset the ledger holds for this user.
     *
     * NOT just the two assets of this pair. The vendor showed exactly two rows
     * because it read a per-asset wallet endpoint twice; ours returns the whole
     * book in one answer, and hiding the rest would misrepresent the account.
     * `used` is shown beside `free` because a held balance is not spendable and
     * a trader who cannot see the difference will size an order they cannot
     * fill.
     *
     * No value column: converting a balance to fiat needs a price per asset and
     * this platform publishes no rate source.
     */
    balanceRows() {
      return this.balances;
    },
    fills() {
      return this.myFills;
    },
    accountTabs() {
      /* SOURCE-READ: balances, positions, open, fills, history, drop-copy,
         and perp funding-history already have desk queries. RFQ / borrow /
         strategies / transfers / errors do not — helper marks them unavailable. */
      return ixBlotterTabs.blotterTabs({
        isPerpKind: this.isPerpKind,
        positionsCount: this.isPerpKind ? this.positions.length : 0,
        openCount: this.openOrders.length,
        fundingHistoryCount: this.fundingHistory.length,
        dropCopyLabel: this.$t('exchange.hlplus.dropCopyTitle')
      });
    },
    /**
     * remaining-SOT §19.6 M08/M10 — four named margin products, dated-futures
     * expiry strip, hedge vs one-way. Doors stay unset (no invented switch).
     * Isolated-only note above is not this list.
     */
    perpTruthRows() {
      return ixDeskM08M10.deskRows({
        markets: this.markets,
        positions: this.positions
      });
    },
    activeAccountTab() {
      return ixBlotterTabs.tabById(this.accountTabs, this.accountTab);
    },
    accountTabEmpty() {
      /* Only claim empty when the service answered — unknown ≠ empty.
         Unavailable (query not mounted) is not an empty book. */
      if (this.activeAccountTab && this.activeAccountTab.availability === 'unavailable') return false;
      if (this.accountTab === 'balances') return this.walletReachable && this.balances.length === 0;
      if (this.accountTab === 'fills') return this.fillsReachable && this.fills.length === 0;
      if (this.accountTab === 'positions') return this.isPerpKind && this.positionsReachable && this.positions.length === 0;
      if (this.accountTab === 'funding-history') return this.fundingHistoryReachable && this.fundingHistory.length === 0;
      if (!this.ordersReachable) return false;
      if (this.accountTab === 'open') return this.openOrders.length === 0;
      if (this.accountTab === 'history') return this.historyOrders.length === 0;
      if (this.accountTab === 'drop-copy') return false;
      return false;
    },
    /**
     * The free balance of the asset this side spends, as a decimal STRING, or
     * null when the ledger has no row for it.
     *
     * Null propagates deliberately: `canSize` refuses to compute a percentage
     * of an unknown balance, and `validateOrderFields` will not claim
     * "insufficient balance" against a number it does not have.
     */
    availableBalance() {
      return this.side === 'BUY' ? this.wallet.base : this.wallet.coin;
    },
    /* Market buys are sized in the quote asset, everything else in the base. */
    quoteSized() {
      return !this.isPerpKind && this.orderType === 'MARKET_PRICE' && this.side === 'BUY';
    },
    amountLabel() {
      return this.quoteSized ? 'Total' : 'Amount';
    },
    amountUnit() {
      return this.quoteSized ? this.currentCoin.base : this.currentCoin.coin;
    },
    orderValue() {
      if (this.quoteSized) {
        return this.form.amount;
      }
      /* Decimal product for the ticket summary — not a wire amount. */
      return ixMoney.multiply(this.form.price, this.form.amount, this.baseCoinScale);
    },
    /**
     * Wave B8 — rough walk of top-of-book for market size already on the page.
     * Estimate only; never invents fill when book is empty / unreachable.
     */
    marketImpactLabel() {
      if (this.orderType !== 'MARKET_PRICE') return '';
      if (!this.bookReachable) {
        return this.$t
          ? this.$t('exchange.terminal.impactBookUnknown')
          : 'book unknown';
      }
      /* Decimal walk of top-of-book — never IEEE avg (ix-market-impact). */
      const levels =
        this.side === 'BUY'
          ? this.groupPlate(this.plate.asks, 'ask').slice().reverse()
          : this.groupPlate(this.plate.bids, 'bid').slice();
      const est = ixMarketImpact.estimateMarketImpact({
        size: this.form.amount,
        quoteSized: !!this.quoteSized,
        levels: levels,
        mid: this.lastPrice,
        side: this.side,
        scale: this.baseCoinScale,
        money: ixMoney
      });
      if (!est.ok) {
        if (est.reason === 'bad-size') return '';
        return this.$t
          ? this.$t('exchange.terminal.impactNoDepth')
          : 'no depth';
      }
      const avgWord = this.$t
        ? this.$t('exchange.terminal.impactAvg')
        : 'avg';
      let line = avgWord + ' ' + est.avg;
      if (est.slipPct != null) {
        line += ' · ~' + est.slipPct + '%';
      }
      if (est.partial) {
        const part = this.$t
          ? this.$t(
              est.slipPct != null
                ? 'exchange.terminal.impactPartial'
                : 'exchange.terminal.impactPartialBook'
            )
          : est.slipPct != null
            ? 'partial'
            : 'partial book';
        line += ' · ' + part;
      }
      return line;
    },
    /* A percent of an unknown balance is not a number. isPositive is false for
       null/empty, so the percent buttons stay off rather than sizing fiction. */
    canSize() {
      return !this.advancedPlanLocked && this.isLogin && ixMoney.isPositive(this.availableBalance) &&
        (this.orderType === 'MARKET_PRICE' || ixMoney.isPositive(this.form.price));
    },
    marketAllowed() {
      return this.side === 'BUY' ? this.enableMarketBuy == 1 : this.enableMarketSell == 1;
    },
    deskLock() {
      return ixOrderBlock.classifyOrderBlock({
        isLogin: this.isLogin,
        submitting: this.submitting || !!(this.dupTabLockHeld && this.dupTabLockHeld.clientOrderId),
        recoveryLocked: this.isLogin === true && this.openOrdersReachable !== true,
        orderEntryLocked: this.orderEntryLocked === true,
        feedLive: this.feedLive,
        walletReachable: this.walletReachable,
        marketHalted: this.exchangeable != 1,
        tradable: this.ticketCapability !== 'peg' && this.ticketCapability !== 'rfq'
        /* tradingEnabled omitted: no desk observation exists; do not invent true. */
      });
    },
    /**
     * R09: persistent per-channel facts for the existing header title/copy.
     * Trading WS and clock are omitted until the desk has those observations.
     * Unset does not invent live. Failed ≠ empty.
     */
    channelStatus() {
      var trades;
      if (this.tradesLoading) {
        trades = undefined;
      } else if (this.tradesReachable === false) {
        trades = { reachable: false };
      } else {
        trades = { reachable: true, empty: !(this.trades && this.trades.length) };
      }
      var depth;
      if (this.feedLive === true) {
        var bids = (this.plate && this.plate.bids && this.plate.bids.length) || 0;
        var asks = (this.plate && this.plate.asks && this.plate.asks.length) || 0;
        depth = { live: true, empty: bids === 0 && asks === 0 };
      } else {
        depth = false;
      }
      var candles;
      if (this.chartFailed === true || this.chartStatus === 'failed') {
        candles = { status: 'failed' };
      } else if (this.chartStatus === 'empty') {
        candles = { status: 'empty' };
      } else if (this.chartProvenance && this.chartProvenance.live === true) {
        candles = { live: true };
      }
      var priv;
      if (this.isLogin === true && this.accountLoading !== true) {
        priv = this.openOrdersReachable === true;
      }
      var deps;
      if (this.isLogin === true && this.accountLoading !== true && this.walletReachable === false) {
        deps = { degraded: true };
      } else if (this.marketsLoading !== true && this.marketsReachable === false) {
        deps = { degraded: true };
      } else if (this.layoutPrefsNotice) {
        deps = { degraded: true };
      }
      return ixChannelStatus.classifyChannelStatus({
        auth: this.isLogin === true,
        private: priv,
        md: { depth: depth, trades: trades, candles: candles },
        schema: { version: deskPrefs.PREFS_VERSION },
        deps: deps
      });
    },
    ticketMarketUnavailable() {
      return !this.feedLive && !this.bookReachable && !this.openOrdersReachable;
    },
    tradable() {
      if (!this.isLogin || this.submitting) return false;
      if (this.ticketCapability === 'peg' || this.ticketCapability === 'rfq') return false;
      /* R11 + R10: any classified desk lock refuses new intent. */
      var lock = this.deskLock;
      if (lock) return false;
      if (!this.openOrdersReachable) return false;
      if (this.exchangeable != 1) return false;
      if (this.orderType === 'MARKET_PRICE' && !this.marketAllowed) return false;
      /* A-UI-SUB: sub selection blocks place until money routing is wired. */
      if (!subAccounts.canPlaceOrder(this.$store.state.ixSubAccountId)) return false;
      return true;
    },
    /** Structural block (halt/market type / sub routing) — separate from field validation. */
    orderBlockReason() {
      if (!this.isLogin) return '';
      if (this.ticketCapability === 'peg') return 'Peg orders are unavailable; no reference-price contract exists and no order will be placed.';
      if (this.ticketCapability === 'rfq') return this.$t('exchange.residual.rfqRefuse');
      var lock = this.deskLock;
      if (lock && lock.key === 'recovery_locked') return this.$t('exchange.residual.openOrdersUnknown');
      if (lock) return lock.message;
      if (!this.openOrdersReachable) return this.$t('exchange.residual.openOrdersUnknown');
      if (this.exchangeable != 1) return this.$t('exchange.terminal.halted');
      if (this.orderType === 'MARKET_PRICE' && !this.marketAllowed) {
        return this.$t('exchange.terminal.marketDisabled', {
          side: this.side === 'BUY' ? 'buy' : 'sell'
        });
      }
      if (this.positionPreviewRequired) {
        if (!positionPreviewWire.toRequest({
          symbol: this.currentCoin.symbol,
          side: this.side,
          size: String(this.form.amount || '').trim(),
          leverage: String(this.positionLeverage || '').trim()
        }).ok) return this.$t('exchange.hlplus.previewInputRequired');
        if (this.positionPreviewLoading) return this.$t('exchange.hlplus.previewLoading');
        if (!this.positionPreview) return this.positionPreviewMessage || this.$t('exchange.hlplus.previewUnavailable');
        if (!this.positionPreview.orderable) {
          return this.positionPreview.refusals.length
            ? this.positionPreview.refusals[0].message
            : this.$t('exchange.hlplus.previewRefused');
        }
      }
      if (this.spotOrderPreviewRequired) {
        if (this.reduceOnly) return this.$t('exchange.residual.spotReduceOnlyUnsupported');
        if (!spotOrderPreviewWire.toRequest(this.spotOrderPreviewInput()).ok) {
          return this.$t('exchange.residual.spotPreviewInputRequired');
        }
        if (this.spotOrderPreviewLoading) return this.$t('exchange.residual.spotPreviewLoading');
        if (!this.spotOrderPreview) return this.spotOrderPreviewMessage || this.$t('exchange.residual.spotPreviewUnavailable');
        if (!this.spotOrderPreview.orderable) {
          return this.spotOrderPreview.refusals.length
            ? this.spotOrderPreview.refusals[0].message
            : this.$t('exchange.residual.spotPreviewRefused');
        }
      }
      var subBlock = subAccounts.tradeBlockReason(this.$store.state.ixSubAccountId);
      if (subBlock) return subBlock;
      return '';
    },
    submitLabel() {
      if (this.amendOrder) return this.$t('exchange.residual.submitAmend');
      if (this.orderType === 'twap') return this.$t('exchange.hlplus.submitTwap');
      if (this.orderType === 'scale') return this.$t('exchange.hlplus.submitScale');
      if (this.orderType === 'tpsl') return this.$t('exchange.hlplus.submitAttachedTpsl');
      const verb = this.side === 'BUY'
        ? this.$t('exchange.terminal.buy')
        : this.$t('exchange.terminal.sell');
      return this.currentCoin.coin ? verb + ' ' + this.currentCoin.coin : verb;
    },
    /* Last / 24h stats: never present a cold zero as a live market print. */
    lastPriceLabel() {
      return this.marketNum(this.lastPrice, this.baseCoinScale);
    },
    feeLabel() {
      if (!this.feeKnown) {
        return this.$t('exchange.terminal.feeUnknown');
      }
      /* symbolFee is the published TAKER rate as a decimal string ("0.001").
         pctOf multiplies in decimal — a label, not a charge. */
      return this.$t('exchange.terminal.feeTakerSchedule', {
        pct: this.pctOf(this.symbolFee, 2)
      });
    },
    tradesEmptyLabel() {
      return bookHonesty.tradesEmptyLabel({
        loading: this.tradesLoading,
        reachable: this.tradesReachable,
        message: this.tradesMessage || null
      });
    }
  },

  watch: {
    $route() {
      this.syncDeskKindFromRoute();
      if (!this.isPerpKind && this.accountTab === 'funding-history') this.accountTab = 'balances';
      this.init();
    },
    isLogin(value) {
      if (value) {
        this.loadAccount();
        this.schedulePositionPreview();
        this.scheduleSpotOrderPreview();
        if (this.deskMode === 'copy') this.loadCopyFollows();
        this.startCodStream();
        this.startDropCopyStream();
      } else {
        this.openOrders = [];
        this.historyOrders = [];
        this.amendOrder = null;
        this.pendingOutcome = null;
        this.reconcilingOutcome = false;
        this.pendingClientOrderId = '';
        this.stagedBatchOrders = [];
        this.batchResults = [];
        this.pendingBatchOutcome = null;
        this.batchMessage = '';
        this.batchStateLoaded = false;
        this.stagedBatchAmends = [];
        this.batchAmendResults = [];
        this.batchAmendMessage = '';
        this.pendingBatchAmendOutcome = null;
        this.positions = [];
        this.positionsReachable = false;
        this.positionsMessage = '';
        this.adlDisclosure = { version: '', copy: '', acknowledged: false, acknowledgedAt: null };
        this.adlDisclosureLoading = false;
        this.wallet = { base: null, coin: null };
        this.accountError = '';
        this.accountLoading = false;
        this.walletReachable = false;
        this.ordersReachable = false;
        this.clearPositionPreview(false);
        this.clearSpotOrderPreview();
        this.copyFollows = [];
        this.copyFollowsReachable = false;
        this.stopCodStream();
        this.stopDropCopyStream();
      }
    },
    ixToken(value, previous) {
      if (subjectOf(value) !== subjectOf(previous)) this.switchDeskPrefsPrincipal();
    },
    deskMode(mode) {
      if (mode === 'copy') this.loadCopyFollows();
      this.scheduleSpotOrderPreview();
    },
    'currentCoin.close': function (value) {
      const next = ixMoney.toBN(value) === null ? null : String(value);
      if (next !== null && this.lastTick !== null) {
        const direction = ixMoney.compare(next, this.lastTick);
        if (direction !== null && direction !== 0) this.trend = direction;
      }
      this.lastTick = next;
    },
    /* Wave B5 — cheap desk memory (local only; never money). */
    bookMode() {
      this.saveDeskPrefs();
    },
    bookGroup() {
      this.saveDeskPrefs();
    },
    interval() {
      this.saveDeskPrefs();
    },
    'indicatorVisibility.rsi'() {
      this.saveDeskPrefs();
    },
    'indicatorVisibility.macd'() {
      this.saveDeskPrefs();
    },
    mainTab() {
      this.saveDeskPrefs();
    },
    railTab() {
      this.saveDeskPrefs();
    },
    baseFilter() {
      this.saveDeskPrefs();
    },
    accountTab() {
      this.saveDeskPrefs();
    },
    side() {
      this.saveDeskPrefs();
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },
    timeInForce() {
      this.scheduleSpotOrderPreview();
    },
    postOnly() {
      this.scheduleSpotOrderPreview();
    },
    amendOrder() {
      this.$nextTick(() => this.syncChartRepriceStage());
    },
    'form.price'() {
      if (this._chartRepriceUpdating) return;
      this.$nextTick(() => this.syncChartRepriceStage());
    },
    'currentCoin.tickSize'() {
      this.$nextTick(() => this.syncChartRepriceStage());
    },
    chartStatus() {
      this.$nextTick(() => this.syncChartRepriceStage());
    }
  },

  created() {
    /* Deliberately NOT in data(). Vue would deep-observe these, and
       isPlainObject() is true for class instances — it would walk the chart
       library widget into its internal handles, defining accessors all the way
       down. None of them are rendered, so none of them need to be reactive. */
    this.klineChart = null;
    this.depthTimer = 0;
    this.depthPending = false;
    this.depthFeed = null;
    this.lastTick = null;
    this._positionPreviewTimer = 0;
    this._positionPreviewSeq = 0;
    this._spotOrderPreviewTimer = 0;
    this._spotOrderPreviewSeq = 0;
    this._codStream = null;
    this._dropCopyStream = null;
    this._chartRepriceUpdating = false;
    this._dupTabLock = null;
    this._dupTabLockOwned = false;

    /* Loading touches watched fields. Do not rewrite a partially hydrated
       layout while those watcher callbacks drain. */
    this._deskPrefsSuspend = true;
    this.loadDeskPrefs();
    this.$nextTick(() => { this._deskPrefsSuspend = false; });
    this.syncDeskKindFromRoute();
    this.syncPanelResizeActive();
    /* B7 — capture when focus is not in a field (document-level). */
    this._onDeskKeyWindow = e => this.onDeskKeydown(e, true);
    this._onWinResize = () => this.syncPanelResizeActive();
    /* remaining-SOT §12.4 — visibility/focus/reconnect revalidate snapshots. */
    this._onDeskVisibility = () => this.onDeskVisibilityChange();
    this._onDeskFocus = () => this.onDeskReconnect('focus');
    this._onDeskOnline = () => this.onDeskReconnect('online');
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onDeskVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onDeskKeyWindow, true);
      window.addEventListener('resize', this._onWinResize);
      window.addEventListener('focus', this._onDeskFocus);
      window.addEventListener('online', this._onDeskOnline);
      this.bindDupTabSubmitLock(window);
    }
  },

  mounted() {
    /* init mutates rendered state and mounts the imperative chart. Starting it
       in created() let fast/refused requests queue a patch before Vue had
       inserted this async route component, which could strand the visible DOM
       behind an insertBefore NotFoundError. */
    this.init();
    if (this.isLogin) {
      this.startCodStream();
      this.startDropCopyStream();
    }
  },

  beforeDestroy() {
    clearTimeout(this._positionPreviewTimer);
    this._positionPreviewTimer = 0;
    this._positionPreviewSeq += 1;
    clearTimeout(this._spotOrderPreviewTimer);
    this._spotOrderPreviewTimer = 0;
    this._spotOrderPreviewSeq += 1;
    if (typeof document !== 'undefined' && this._onDeskVisibility) {
      document.removeEventListener('visibilitychange', this._onDeskVisibility);
    }
    if (typeof window !== 'undefined') {
      if (this._onDeskKeyWindow) {
        window.removeEventListener('keydown', this._onDeskKeyWindow, true);
      }
      if (this._onWinResize) {
        window.removeEventListener('resize', this._onWinResize);
      }
      if (this._onDeskFocus) {
        window.removeEventListener('focus', this._onDeskFocus);
      }
      if (this._onDeskOnline) {
        window.removeEventListener('online', this._onDeskOnline);
      }
    }
    if (this._dupTabLock && typeof this._dupTabLock.close === 'function') {
      this._dupTabLock.close();
    }
    this._dupTabLock = null;
    this.stopCodStream();
    this.stopDropCopyStream();
    this.teardown();
  },

  methods: {
    /* ── plumbing ──────────────────────────────────────────────────────── */

    bindDupTabSubmitLock(win) {
      var self = this;
      this._dupTabLockOwned = false;
      this._dupTabLock = ixDupTabLock.createDupTabLock(win, function (payload) {
        self.dupTabLockHeld = ixDupTabLock.isHeld(payload) ? payload : null;
      });
      var held = this._dupTabLock.read();
      this.dupTabLockHeld = ixDupTabLock.isHeld(held) ? held : null;
    },

    acquireDupTabSubmitLock(clientOrderId) {
      if (!this._dupTabLock) return true;
      var ok = this._dupTabLock.acquire(clientOrderId) === true;
      if (ok) this._dupTabLockOwned = true;
      return ok;
    },

    releaseDupTabSubmitLock() {
      if (!this._dupTabLockOwned) return;
      this._dupTabLockOwned = false;
      if (this._dupTabLock) this._dupTabLock.release();
      this.dupTabLockHeld = null;
    },

    /**
     * remaining-SOT §12.4 — tab return / focus / reconnect re-call existing
     * snapshot loaders. Elapsed client time does not prove freshness.
     * Loaders stay refuse-closed; this method never invents success.
     */
    onDeskVisibilityChange() {
      var vis = typeof document !== 'undefined' ? document.visibilityState : '';
      if (!deskVisibility.shouldRevalidate({ type: 'visibilitychange', visibilityState: vis })) {
        return;
      }
      this.revalidateSnapshots();
    },
    onDeskReconnect(type) {
      if (!deskVisibility.shouldRevalidate({ type: type })) return;
      this.revalidateSnapshots();
    },
    revalidateSnapshots() {
      this.getPlate();
      this.loadAccount();
    },

    /**
     * A-UI-1 / Wave B7+ keyboard floor (desk only — no new backend).
     * Map lives in assets/js/desk-hotkeys.js; handlers call existing methods only.
     * @param {KeyboardEvent} e
     * @param {boolean} fromWindow capture-phase for global shortcuts when focus is outside the desk tree
     */
    toggleOrderEntryLock() {
      this.orderEntryLocked = this.orderEntryLocked !== true;
    },

    onDeskKeydown(e, fromWindow) {
      if (!e || e.defaultPrevented) return;
      const t = e.target;
      const tag = (t && t.tagName) || '';
      const typing = deskHotkeys.isTypingTarget(tag, t && t.isContentEditable);
      const hit = deskHotkeys.resolveDeskHotkey(e, {
        typing: typing,
        fromWindow: !!fromWindow,
        orderEntryLocked: this.orderEntryLocked === true,
        locked: !!(this.deskLock && this.deskLock.key === 'order_entry_locked')
      });
      if (!hit) return;
      if (hit.preventDefault) e.preventDefault();

      switch (hit.action) {
        case 'escape':
          if (this.searchKey) this.searchKey = '';
          if (this.marketsOpen) {
            this.closeMarkets(true);
          } else if (typing && t && typeof t.blur === 'function') {
            t.blur();
          }
          break;
        case 'focus_market_search':
          this.focusMarketSearch();
          break;
        case 'focus_buy_ticket':
          this.focusTicket('BUY');
          break;
        case 'focus_sell_ticket':
          this.focusTicket('SELL');
          break;
        case 'focus_ticket':
          this.focusTicket();
          break;
        case 'cancel_last_open':
          this.cancelLastOpenOrder();
          break;
        case 'submit':
          /* Field @keydown.enter.prevent also calls submitOrder; defaultPrevented
             on the bubbled event skips a second resolve. This path is for
             direct/tests and any non-prevented field bubble. */
          this.submitOrder();
          break;
        default:
          break;
      }
    },

    focusMarketSearch() {
      this.marketsOpen = true;
      this.$nextTick(() => {
        const el = this.$refs.marketSearch;
        if (el && typeof el.focus === 'function') {
          el.focus();
          if (typeof el.select === 'function') el.select();
        }
      });
    },

    toggleMarkets() {
      if (this.marketsOpen) {
        this.closeMarkets(true);
        return;
      }
      this.focusMarketSearch();
    },

    closeMarkets(restoreFocus) {
      this.marketsOpen = false;
      if (!restoreFocus) return;
      this.$nextTick(() => {
        const trigger = this.$refs.marketDrawerTrigger;
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
      });
    },

    trapMarketDrawerTab(e) {
      if (!e || this.panelResizeActive || !this.marketsOpen) return;
      const drawer = e.currentTarget;
      if (!drawer || typeof drawer.querySelectorAll !== 'function') return;
      const focusables = Array.prototype.slice.call(
        drawer.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!deskA11y.shouldTrapTab(true, focusables.length)) return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const activeIndex = focusables.indexOf(active);
      const nextIndex = deskA11y.tabWrapIndex(activeIndex, focusables.length, !!e.shiftKey);
      if (nextIndex < 0 || (activeIndex >= 0 && nextIndex === activeIndex + (e.shiftKey ? -1 : 1))) {
        return;
      }
      e.preventDefault();
      focusables[nextIndex].focus();
    },

    /**
     * Focus the order ticket; optional side flips Buy/Sell first (clears amount via setSide).
     * Prefers price (limit) then amount — real inputs only, no invented values.
     * @param {'BUY'|'SELL'|undefined} side
     */
    focusTicket(side) {
      if ((side === 'BUY' || side === 'SELL') && this.side !== side) {
        this.setSide(side);
      }
      this.$nextTick(() => {
        const priceEl = this.$refs.ticketPrice;
        const amountEl = this.$refs.ticketAmount;
        let el = null;
        if (this.orderType === 'LIMIT_PRICE' && priceEl && !priceEl.disabled) {
          el = priceEl;
        } else if (amountEl) {
          el = amountEl;
        }
        if (el && typeof el.focus === 'function') {
          el.focus();
          if (typeof el.select === 'function') el.select();
          return;
        }
        const panel =
          typeof document !== 'undefined' ? document.getElementById('ix-ticket') : null;
        if (panel && typeof panel.focus === 'function') panel.focus();
      });
    },

    /**
     * A-UI-SUB — selection changed in the header switcher.
     * Does not touch balances or order payload; tradeBlockReason handles gating.
     */
    onSubAccountChange() {
      var reason = subAccounts.tradeBlockReason(this.$store.state.ixSubAccountId);
      if (reason) {
        this.orderValidationError = reason;
        this.liveAnnounce = reason;
      } else if (
        this.orderValidationError &&
        this.orderValidationError.indexOf('Sub-account selected') === 0
      ) {
        this.orderValidationError = '';
        this.liveAnnounce = '';
      }
    },

    /**
     * Cancel the most recent open order via existing cancelOrder (confirm modal).
     * Does not invent order ids or skip venue confirm.
     */
    cancelLastOpenOrder() {
      if (this.cancellingId) return;
      if (!this.isLogin) {
        return this.warn('Sign in to cancel orders.');
      }
      if (!this.ordersReachable) {
        return this.warn('Open orders unknown — cannot cancel from keyboard.');
      }
      const list = this.openOrders || [];
      if (!list.length) {
        return this.warn('{{ $t("exchange.residual.noOpenOrders") }} to cancel.');
      }
      let order = list[0];
      for (let i = 1; i < list.length; i++) {
        const row = list[i];
        if (row && order && Number(row.time) > Number(order.time)) {
          order = row;
        }
      }
      if (!order || !order.orderId) {
        return this.warn('No cancellable open order found.');
      }
      this.accountTab = 'open';
      this.cancelOrder(order);
    },

    /* REMOVED: request(). It POSTed to the Java backend through `this.$http`
       and flattened every outcome to `null`, which is why "the service refused"
       and "there is nothing here" were indistinguishable everywhere it was
       used. `rest()` from config/intafaced.js replaces it: it also never
       rejects, but it resolves a classified `{ ok, reason, message, data }` so
       each caller can tell a refusal from an empty answer. */

    /* Local display state only. The key contains a JWT subject, never a token. */
    deskPrefsPrincipal() {
      return subjectOf(this.ixToken) || '';
    },
    deskPrefsKey() {
      return deskPrefs.storageKey(this.deskPrefsPrincipal());
    },
    deskPrefsStorage() {
      if (typeof window === 'undefined') return null;
      try {
        return window.localStorage;
      } catch (e) {
        return null;
      }
    },
    deskPrefsSnapshot() {
      const pair =
        (this.$route && this.$route.params && this.$route.params.pair) ||
        this.defaultPair;
      return {
        pair: String(pair || this.defaultPair).toLowerCase(),
        bookMode: this.bookMode,
        bookGroup: this.bookGroup,
        interval: this.interval,
        mainTab: this.mainTab,
        railTab: this.railTab,
        baseFilter: this.baseFilter,
        accountTab: this.accountTab,
        side: this.side,
        panels: this.panelW,
        indicators: this.indicatorVisibility
      };
    },
    applyDeskPrefs(input) {
      const p = deskPrefs.normalizeLayout(input);
      if (!p) return false;
      this.bookMode = p.bookMode;
      this.bookGroup = p.bookGroup;
      this.interval = p.interval;
      this.mainTab = p.mainTab;
      this.railTab = p.railTab;
      this.baseFilter = p.baseFilter;
      this.defaultPair = p.pair;
      this.accountTab = p.accountTab;
      this.side = p.side;
      this.panelW = Object.assign({}, p.panels);
      this.indicatorVisibility = Object.assign({}, p.indicators);
      if (this.klineChart) this.klineChart.setIndicators(this.indicatorVisibility);
      return true;
    },
    loadDeskPrefs() {
      const storage = this.deskPrefsStorage();
      if (!storage) {
        this.layoutPrefsNotice = 'Layout storage is unavailable; changes will last for this visit only.';
        return;
      }
      const principal = this.deskPrefsPrincipal();
      let result = deskPrefs.read(storage, principal);
      if (!result.ok && result.reason === 'missing' && !principal) {
        result = deskPrefs.migrateLegacyGuest(storage, principal);
      }
      if (result.ok) {
        this.applyDeskPrefs(result.layout);
        this.layoutPrefsNotice = result.migrated ? 'Your local layout was upgraded.' : '';
        return;
      }
      if (result.reason === 'corrupt' || result.reason === 'version' || result.reason === 'principal') {
        this.layoutPrefsNotice = 'Saved layout was invalid and was reset safely.';
      } else if (result.reason === 'storage_unavailable') {
        this.layoutPrefsNotice = 'Layout storage is unavailable; changes will last for this visit only.';
      }
    },
    saveDeskPrefs() {
      if (this._deskPrefsSuspend) return;
      const storage = this.deskPrefsStorage();
      if (!storage) {
        this.layoutPrefsNotice = 'Layout storage is unavailable; changes will last for this visit only.';
        return;
      }
      const result = deskPrefs.write(
        storage,
        this.deskPrefsPrincipal(),
        this.deskPrefsSnapshot()
      );
      if (result.ok) {
        if (this.layoutPrefsNotice.indexOf('storage') >= 0) this.layoutPrefsNotice = '';
      } else if (result.reason === 'quota') {
        this.layoutPrefsNotice = 'Layout could not be saved because browser storage is full.';
      } else {
        this.layoutPrefsNotice = 'Layout storage is unavailable; changes will last for this visit only.';
      }
    },
    resetDeskLayout() {
      const storage = this.deskPrefsStorage();
      let notice = 'Layout reset to defaults.';
      if (storage) {
        const removed = deskPrefs.remove(storage, this.deskPrefsPrincipal());
        if (!removed.ok) {
          notice = 'Layout storage is unavailable; defaults apply for this visit only.';
        }
      } else {
        notice = 'Layout storage is unavailable; defaults apply for this visit only.';
      }
      this._deskPrefsSuspend = true;
      this.applyDeskPrefs(deskPrefs.LAYOUT_DEFAULTS);
      this.$nextTick(() => {
        this._deskPrefsSuspend = false;
        this.layoutPrefsNotice = notice;
      });
    },
    switchDeskPrefsPrincipal() {
      this._deskPrefsSuspend = true;
      this.applyDeskPrefs(deskPrefs.LAYOUT_DEFAULTS);
      this.layoutPrefsNotice = '';
      this.loadDeskPrefs();
      this.$nextTick(() => { this._deskPrefsSuspend = false; });
    },
    panelWidthMin(key) {
      return deskPrefs.PANEL_LIMITS[key] ? deskPrefs.PANEL_LIMITS[key].min : 0;
    },
    panelWidthMax(key) {
      return deskPrefs.PANEL_LIMITS[key] ? deskPrefs.PANEL_LIMITS[key].max : 0;
    },
    resizePanelByKey(key, e) {
      if (!this.panelResizeActive || !e) return;
      const lim = deskPrefs.PANEL_LIMITS[key];
      if (!lim) return;
      let next = this.panelW[key];
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next += 8;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next -= 8;
      else if (e.key === 'Home') next = lim.min;
      else if (e.key === 'End') next = lim.max;
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.$set(this.panelW, key, deskPrefs.clampPanelWidth(key, next));
      this.saveDeskPrefs();
    },
    /** The current desk stacks book and ticket in one shared right column. */
    startPanelResize(key, e) {
      if (!this.panelResizeActive || !e || typeof window === 'undefined') return;
      var startX = e.clientX;
      var startW = deskPrefs.clampPanelWidth(key, this.panelW[key]);
      var sign = key === 'markets' ? 1 : -1;
      var self = this;
      function onMove(ev) {
        if (!ev) return;
        var next = deskPrefs.panelWidthAfterDrag(key, startW, sign * (ev.clientX - startX));
        self.$set(self.panelW, key, next);
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        document.body.classList.remove('ix-resizing-cols');
        self.saveDeskPrefs();
      }
      document.body.classList.add('ix-resizing-cols');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    },
    syncPanelResizeActive() {
      if (typeof window === 'undefined') return;
      this.panelResizeActive = window.innerWidth >= 1500;
    },

    syncDeskKindFromRoute() {
      const kind = this.$route && this.$route.query && this.$route.query.kind;
      if (kind === 'perp') this.deskMode = 'perp';
      else if (kind === 'spot' && this.deskMode === 'perp') this.deskMode = 'spot';
    },

    setDeskKind(kind) {
      if (kind !== 'spot' && kind !== 'perp') return;
      this.deskMode = kind;
      const query = Object.assign({}, (this.$route && this.$route.query) || {}, { kind });
      this.$router.replace({ path: this.$route.path, query });
    },

    init() {
      const pair = this.$route.params.pair;
      if (!pair) {
        this.$router.replace({ path: '/exchange/' + this.defaultPair, query: this.$route.query || {} });
        return;
      }

      const parts = pair.toUpperCase().split('_');
      const coin = parts[0];
      const base = parts[1] || 'USDT';

      this.teardown();

      this.currentCoin = Object.assign({}, this.currentCoin, {
        coin,
        base,
        symbol: coin + '/' + base
      });
      this.batchStateLoaded = false;
      this.restoreBatchState();
      if (this.pendingOutcome && this.pendingOutcome.action !== 'cancel_all' && this.pendingOutcome.symbol !== this.currentCoin.symbol) {
        this.pendingOutcome = null;
        this.reconcilingOutcome = false;
      }
      this.amendOrder = null;
      this.clearPendingOrderIdentity();
      this.restorePendingOutcome();
      this.clearPendingAlgoIdentity();
      this.clearPendingAdvancedIdentity();
      this.clearPositionPreview(true);
      this.clearSpotOrderPreview();
      this.scheduleSpotOrderPreview();
      /* Keep a remembered market-list filter when it is "favor"; otherwise
         follow the pair's quote so the list matches the desk. */
      if (this.baseFilter !== 'favor') {
        this.baseFilter = base;
      }
      this.saveDeskPrefs();
      this.trend = 0;
      this.lastTick = null;
      this.chartFailed = false;
      this.feeKnown = false;
      this.marketsLoading = false;
      this.marketsReachable = false;
      this.bookLoading = true;
      this.bookReachable = false;
      this.bookReason = null;
      this.tradesLoading = true;
      this.tradesReachable = false;
      this.plate = { asks: [], bids: [], askTotal: null, bidTotal: null };
      this.trades = [];
      this.openOrders = [];
      this.allOpenOrders = [];
      this.openOrdersReachable = false;
      this.allOpenOrdersReachable = false;
      this.percent = 0;
      this.form = { price: '', amount: '' };
      this.orderValidationError = '';

      this.$store.commit('navigate', 'nav-exchange');
      this.$store.commit('setSkin', 'night');

      this.loadFavorites();
      this.getMarkets();
      this.getPlate();
      this.getTrades();
      this.getFuturesTicker();
      this.loadAccount();

      /* The chart needs the price scale, so it waits for the listing — but
         only once, and it starts even when that request fails. */
      this.getSymbolScale().then(() => {
        this.$nextTick(() => this.mountChart());
      });
    },

    teardown() {
      this.destroyChart();
      this.stopDepthFeed();
      clearTimeout(this.depthTimer);
      this.depthTimer = 0;
      this.depthPending = false;
    },

    startCodStream() {
      this.stopCodStream();
      if (!this.ixToken) return;
      var self = this;
      this._codStream = ixCod.createPrivateCodStream({
        accessToken: this.ixToken,
        onView: function (view) {
          self.codView = view;
        }
      });
    },

    stopCodStream() {
      if (this._codStream && typeof this._codStream.stop === 'function') {
        this._codStream.stop();
      }
      this._codStream = null;
      this.codView = ixCod.emptyView();
    },

    startDropCopyStream() {
      this.stopDropCopyStream();
      if (!this.ixToken) return;
      var self = this;
      this._dropCopyStream = ixDropCopy.createDropCopyStream({
        accessToken: this.ixToken,
        onView: function (view) {
          self.dropCopyView = view;
        }
      });
    },

    stopDropCopyStream() {
      if (this._dropCopyStream && typeof this._dropCopyStream.stop === 'function') {
        this._dropCopyStream.stop();
      }
      this._dropCopyStream = null;
      this.dropCopyView = ixDropCopy.emptyView();
    },

    armCod() {
      if (!this._codStream) this.startCodStream();
      if (!this._codStream) return;
      var input = { ttlMs: this.codTtlMs, scope: this.codScope };
      if (this.codScope === 'market' && this.currentCoin && this.currentCoin.symbol) {
        input.marketId = this.currentCoin.symbol;
      }
      this._codStream.arm(input);
    },

    renewCod() {
      if (!this._codStream) return;
      this._codStream.renew();
    },

    disarmCod() {
      if (!this._codStream) return;
      this._codStream.disarm();
    },

    /* ── chart ─────────────────────────────────────────────────────────── */

    mountChart() {
      const host = document.getElementById('ix_kline');
      if (!host) {
        return;
      }
      this.destroyChart();
      this.chartFailed = false;

      const chart = new KlineChart({
        hostEl: host,
        /* The CCXT REST base. The chart appends /ohlcv/<symbol>. */
        baseUrl: REST_BASE,
        symbol: this.currentCoin.symbol,
        marketId: (this.currentCoin && this.currentCoin.id) ||
          (this.marketMap && this.marketMap[this.currentCoin.symbol] && this.marketMap[this.currentCoin.symbol].id) ||
          (this.market && this.market.id) || null,
        resolution: this.interval,
        scale: this.baseCoinScale,
        indicators: this.indicatorVisibility,
        onState: (state) => {
          if (this.klineChart === chart) {
            this.chartProvenance = state;
            if (state.status === 'ok' || state.status === 'empty' || state.status === 'failed') {
              this.chartStatus = state.status;
              this.chartFailed = state.status === 'failed';
            }
          }
        },
        onAccessibleState: (state) => {
          if (this.klineChart === chart) this.chartAccessibleState = state;
        }
      });
      this.klineChart = chart;
      chart
        .mount()
        .then((status) => {
          if (this._isDestroyed || this.klineChart !== chart) {
            return;
          }
          /* Three states, three sentences. 'empty' is a market that has never
             traded and is NOT a failure; conflating the two is what made a
             dead data source look identical to a quiet market. */
          this.chartStatus = status;
          this.chartFailed = status === 'failed';
          this.syncChartRepriceStage();
        })
        .catch(() => {
          if (this.klineChart === chart) {
            this.chartStatus = 'failed';
            this.chartFailed = true;
          }
        });
    },

    destroyChart() {
      if (this.klineChart) {
        try {
          this.klineChart.dispose();
        } catch (e) {
          const host = document.getElementById('ix_kline');
          if (host) {
            host.innerHTML = '';
          }
        }
        this.klineChart = null;
      }
    },

    setChartInterval(value) {
      this.interval = value;
      if (!this.klineChart) {
        return;
      }
      const chart = this.klineChart;
      chart.setResolution(value).then((status) => {
        if (this.klineChart !== chart || status === 'superseded') return;
        this.chartStatus = status;
        this.chartFailed = status === 'failed';
      }, () => {
        if (this.klineChart !== chart) return;
        this.chartStatus = 'failed';
        this.chartFailed = true;
      });
    },

    toggleIndicator(id) {
      if (id !== 'rsi' && id !== 'macd') return;
      this.$set(this.indicatorVisibility, id, !this.indicatorVisibility[id]);
      if (this.klineChart) this.klineChart.setIndicators(this.indicatorVisibility);
    },

    fitChartContent() {
      if (this.klineChart) this.klineChart.fitContent();
      this.liveAnnounce = 'Chart fitted to all loaded candles.';
    },

    followLatestCandle() {
      if (this.klineChart) this.klineChart.followLatest();
      this.liveAnnounce = 'Chart moved to the latest loaded candle.';
    },

    syncChartRepriceStage() {
      if (!this.klineChart) return;
      if (!this.amendOrder || this.chartStatus !== 'ok' || !this.currentCoin.tickSize) {
        this.klineChart.setRepriceStage(null);
        return;
      }
      const selectedOrderId = String(this.amendOrder.orderId || '');
      this.klineChart.setRepriceStage({
        price: String(this.form.price || ''),
        tickSize: String(this.currentCoin.tickSize),
        label: this.shortOrderId(this.amendOrder),
        onStage: (price) => {
          if (!this.amendOrder || String(this.amendOrder.orderId || '') !== selectedOrderId) return;
          this._chartRepriceUpdating = true;
          this.form.price = price;
          this.onPriceInput();
          this.$nextTick(() => { this._chartRepriceUpdating = false; });
        },
        onRelease: (price) => {
          this.liveAnnounce = 'Reprice staged at ' + price + ' ' + this.currentCoin.base + '. Nothing was submitted; review and confirm the amend.';
        }
      });
    },

    nudgeChartReprice(count) {
      if (!this.chartRepriceAvailable) return;
      const price = this.klineChart.nudgeReprice(count);
      if (price) {
        this.liveAnnounce = 'Reprice staged at ' + price + ' ' + this.currentCoin.base + '. Nothing was submitted.';
      }
    },

    onChartKeydown(event) {
      if (!this.klineChart) return;
      let command = null;
      if (event.key === 'ArrowLeft') command = 1;
      else if (event.key === 'ArrowRight') command = -1;
      else if (event.key === 'Home') command = 'oldest';
      else if (event.key === 'End') command = 'latest';
      if (command === null) return;
      event.preventDefault();
      const candle = this.klineChart.moveAccessibleCursor(command);
      this.liveAnnounce = candle ? this.chartAccessibleSummary : 'No candle is available to inspect.';
    },

    focusStagedReprice() {
      if (!this.amendOrder || this.submitting || this.pendingOutcome) return;
      this.mainTab = 'chart';
      this.$nextTick(() => {
        const field = this.$refs.ticketPrice;
        if (field && typeof field.focus === 'function') field.focus();
        if (field && typeof field.select === 'function') field.select();
      });
      this.liveAnnounce = 'Reprice staged. Edit the price, then review and confirm the amend; nothing was submitted.';
    },

    shortOrderId(order) {
      const id = order && order.orderId != null ? String(order.orderId) : '';
      if (!id) return 'selected';
      return id.length > 12 ? id.slice(0, 5) + '…' + id.slice(-5) : id;
    },

    selectMainTab(id) {
      this.mainTab = id;
      if (id === 'depth') {
        this.$nextTick(() => {
          if (this.$refs.depthGraph) {
            this.$refs.depthGraph.measure();
          }
          this.getPlateFull();
        });
      }
    },

    /* ── market data ───────────────────────────────────────────────────── */

    /* REMOVED: getCNYRate(). It read `/market/exchange-rate/usd-cny` on the
       retired Java market service. This platform publishes no FX rate source,
       so `CNYRate` stays null and `fiatValue` (which already guards on it)
       renders nothing. A fiat conversion from a rate we invented is a price. */

    /* REMOVED: getCoinInfo(). `/market/coin-info` returned vendor CMS copy about
       an asset (description, links, block explorer). We publish no such
       surface, and `coinInfo` stays `{}` — the panels reading it already guard. */

    /**
     * Market rules from `GET /api/v1/markets` — the venue's own listing table.
     *
     * TICK AND LOT, NOT DECIMAL PLACES. Our contract publishes
     * `precisionMode: 'TICK_SIZE'` with the tick and lot themselves, because
     * that is what the engine enforces. The desk needs a decimal-place count to
     * format and clamp input, so it derives one FROM the tick — and that is a
     * display convenience only. It is never used to build an order quantity:
     * seven of our listings have a lot size of 1000 or 10, whose decimal-place
     * count is 0, and rounding an amount to 0 places would produce sizes the
     * engine rejects for a reason the trader cannot see.
     */
    getSymbolScale() {
      return rest('/markets').then(res => {
        if (!res.ok) {
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.markets, res.data);
        if (!gate.ok || !Array.isArray(gate.data)) {
          return;
        }
        const market = gate.data.filter(m => m.symbol === this.currentCoin.symbol)[0];
        if (!market) {
          return;
        }
        this.market = market;
        /* Handles BOTH published precision shapes — the tick/lot strings on
           main and the decimal-place integers the deployed service still
           sends. Reading one as the other formats every price on the desk to
           the wrong number of digits, silently. See ix-trade.js. */
        const pricePlaces = market.precision ? ixTrade.placesFromPrecision(market.precision.price) : null;
        const amountPlaces = market.precision ? ixTrade.placesFromPrecision(market.precision.amount) : null;
        if (pricePlaces !== null) this.baseCoinScale = pricePlaces;
        if (amountPlaces !== null) this.coinScale = amountPlaces;
        /* Taker rate as a decimal string ("0.001"). Known only because the
           venue published it — feeKnown stays false otherwise and the ticket
           says the fee is unknown rather than implying it is free. */
        if (market.taker != null) {
          this.symbolFee = market.taker;
          this.feeKnown = true;
        }
        /* `active: false` is an operator halt. Market orders are supported on
           this venue for both sides; there is no per-side switch in the
           contract, so nothing is invented here. */
        const tradable = market.active !== false ? 1 : 0;
        this.enableMarketBuy = tradable;
        this.enableMarketSell = tradable;
        this.exchangeable = tradable;
      });
    },


    /**
     * The market list — `/markets` for the listing, `/tickers` for prices.
     *
     * Every 24h rollup our ticker publishes is null (no windowed aggregation
     * job exists) and `last` is null until a market prints. Those stay null:
     * `marketNum`/`marketStat` already render null as a dash, and a table of
     * green +0.00% would claim sixteen flat markets.
     */
    getMarkets() {
      this.marketsLoading = true;
      this.marketsReachable = false;
      Promise.all([rest('/markets'), rest('/tickers')]).then(results => {
        const marketsRes = results[0];
        const tickersRes = results[1];
        this.marketsLoading = false;
        if (!marketsRes.ok) {
          this.marketsReachable = false;
          return;
        }
        const marketsGate = ixTrade.accept(ixTrade.schemas.markets, marketsRes.data);
        if (!marketsGate.ok || !Array.isArray(marketsGate.data)) {
          this.marketsReachable = false;
          return;
        }
        this.marketsReachable = true;
        /* Tickers can fail on their own. The listing is still true, so markets
           are shown priceless rather than hidden. A shape failure on tickers is
           treated the same as a transport failure: listing without prices. */
        var tickers = {};
        if (tickersRes.ok) {
          var tickersGate = ixTrade.accept(ixTrade.schemas.tickers, tickersRes.data);
          if (tickersGate.ok && tickersGate.data) tickers = tickersGate.data;
        }
        const rows = ixTrade.toMarketRows(marketsGate.data, tickers);
        const map = {};
        rows.forEach(row => {
          row.isFavor = this.localFavorites.indexOf(row.symbol) >= 0;
          map[row.symbol] = row;
        });
        this.markets = rows;
        this.marketMap = map;

        const current = map[this.currentCoin.symbol];
        if (current) {
          this.currentCoin = Object.assign({}, this.currentCoin, current);
          /* Seed the limit price from the last print ONLY if there is one.
             bookPriceForForm keeps the venue decimal string (truncate/pad),
             never parseFloat().toFixed(). Empty book → no prefill of 0. */
          if (!this.form.price && current.close) {
            var seeded = ixMoney.bookPriceForForm(current.close, this.baseCoinScale);
            if (seeded) this.form.price = seeded;
          }
        }
        this.currentCoinIsFavor = this.localFavorites.indexOf(this.currentCoin.symbol) >= 0;
        /* Depth stream needs the venue UUID (not the symbol). Start after list. */
        this.startDepthFeed();
      });
    },

    /**
     * The order book — `GET /api/v1/orderbook/:symbol`.
     *
     * A 200 with empty bids and asks is the venue answering "nothing is resting
     * here", which is the true state of every book on this platform today. It
     * sets `bookReachable = true` and the ladder renders its empty state. Only
     * a refusal clears reachability, and then the ladder says the book is
     * unknown instead of empty.
     *
     * While the live feed is up, REST is the seed / fallback only — deltas
     * own the ladder via applyPlate (same shape as REST).
     */
    getPlate() {
      rest('/orderbook/' + symbolPath(this.currentCoin.symbol), { query: { limit: BOOK_DEPTH } }).then(res => {
        this.bookLoading = false;
        if (!res.ok) {
          /* Unreachable — clear any prior levels so we never paint a stale book. */
          this.bookReachable = false;
          this.bookReason = res.reason || 'unreachable';
          this.bookMessage = res.message || '';
          this.plate = { asks: [], bids: [], askTotal: null, bidTotal: null };
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.orderBook, res.data);
        if (!gate.ok) {
          /* Shape failure (e.g. float levels) — not an empty book. */
          this.bookReachable = false;
          this.bookReason = gate.reason || 'invalid_response';
          this.bookMessage = gate.message || '';
          this.plate = { asks: [], bids: [], askTotal: null, bidTotal: null };
          return;
        }
        this.bookReachable = true;
        this.bookReason = 'ok';
        this.bookMessage = '';
        const book = gate.data || {};
        this.applyPlate('SELL', ixTrade.toPlateItems(book.asks));
        this.applyPlate('BUY', ixTrade.toPlateItems(book.bids));
        if (this.mainTab === 'depth') {
          this.$nextTick(() => this.getPlateFull());
        }
      });
    },

    bookSideEmpty(side) {
      return bookHonesty.bookSideEmptyLabel({
        loading: this.bookLoading,
        reachable: this.bookReachable,
        side: side,
        /* Shape failures write gate.message here — show it, not a generic "did not respond". */
        message: this.bookMessage || null
      });
    },

    /* One shape for both the REST snapshot and the websocket delta, so the
       book cannot drift between the two sources. Asks are stored best-last.
       Invalid (≤0) levels are dropped — never pad with zero-price placeholders. */
    applyPlate(direction, items) {
      /* normalizePlateLevels owns decimal totals via ix-money; no num callback.
         Empty side → null total (empty is not a zero). */
      const rows = bookHonesty.normalizePlateLevels(items, BOOK_DEPTH);
      const total = rows.length ? rows[rows.length - 1].totalAmount : null;
      if (direction === 'SELL') {
        this.plate.asks = rows.slice().reverse();
        this.plate.askTotal = total;
      } else {
        this.plate.bids = rows;
        this.plate.bidTotal = total;
      }
    },

    /* Throttled: the plate topic fires several times a second and the full
       plate is a separate round trip plus a canvas repaint. */
    getPlateFull() {
      if (this.mainTab !== 'depth') {
        return;
      }
      if (this.depthTimer) {
        this.depthPending = true;
        return;
      }
      this.depthTimer = setTimeout(() => {
        this.depthTimer = 0;
        if (this.depthPending) {
          this.depthPending = false;
          this.getPlateFull();
        }
      }, DEPTH_REDRAW_MS);

      rest('/orderbook/' + symbolPath(this.currentCoin.symbol), { query: { limit: DEPTH_LEVELS } }).then(res => {
        if (!this.$refs.depthGraph) {
          return;
        }
        if (!res.ok) {
          /* Do not redraw from stale state — an empty depth chart is honest,
             a stale one is not. */
          this.$refs.depthGraph.draw({});
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.orderBook, res.data);
        if (!gate.ok) {
          this.$refs.depthGraph.draw({});
          return;
        }
        const book = gate.data || {};
        /* DepthGraph expects the vendor's { ask: { items }, bid: { items } }. */
        this.$refs.depthGraph.draw({
          ask: { items: ixTrade.toPlateItems(book.asks) },
          bid: { items: ixTrade.toPlateItems(book.bids) }
        });
      });
    },

    /**
     * The public tape — `GET /api/v1/trades/:symbol`.
     *
     * `[]` means this market has never printed. That is an answer, so
     * `tradesReachable` is true and the tape renders "no trades yet" rather
     * than "trades unavailable".
     */
    getTrades() {
      rest('/trades/' + symbolPath(this.currentCoin.symbol), { query: { limit: TRADE_LIMIT } }).then(res => {
        this.tradesLoading = false;
        if (!res.ok) {
          this.tradesReachable = false;
          this.tradesMessage = res.message || '';
          this.trades = [];
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.trades, res.data);
        if (!gate.ok) {
          this.tradesReachable = false;
          this.tradesMessage = gate.message || '';
          this.trades = [];
          return;
        }
        this.tradesReachable = true;
        this.tradesMessage = '';
        this.trades = ixTrade.toDeskTrades(gate.data, TRADE_LIMIT);
      });
    },

    /* ── live feed (svc-ws depth) ──────────────────────────────────────── */

    /**
     * Public futures facts. Every field stays independently nullable; an
     * absent publisher is not a zero rate or an inferred deadline.
     */
    getFuturesTicker() {
      this.futuresTicker = {
        markPrice: null,
        markSource: null,
        fundingRate: null,
        fundingPeriodId: null,
        nextFundingTime: null
      };
      this.futuresTickerMessage = '';
      this.fundingHistory = [];
      this.fundingHistoryReachable = false;
      this.fundingHistoryMessage = '';
      if (!this.isPerpKind) return Promise.resolve();
      return rest('/futures/ticker', { query: { symbol: this.currentCoin.symbol } }).then(res => {
        if (!res.ok || !res.data || typeof res.data !== 'object') {
          this.futuresTickerMessage = (res && res.message) || this.$t('exchange.hlplus.futuresTickerUnavailable');
          this.fundingHistoryMessage = this.futuresTickerMessage;
          return;
        }
        const row = res.data;
        const decimal = value => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
        const nullableDecimal = value => value === null || decimal(value);
        const nullableText = value => value === null || (typeof value === 'string' && value.length > 0);
        const valid = nullableDecimal(row.markPrice) &&
          (row.markSource === null || row.markSource === 'depth' || row.markSource === 'venue') &&
          nullableDecimal(row.fundingRate) && nullableText(row.fundingPeriodId) && nullableText(row.nextFundingTime);
        if (!valid) {
          this.futuresTickerMessage = this.$t('exchange.hlplus.futuresTickerUnavailable');
          this.fundingHistoryMessage = this.futuresTickerMessage;
          return;
        }
        this.futuresTicker = {
          markPrice: row.markPrice,
          markSource: row.markSource,
          fundingRate: row.fundingRate,
          fundingPeriodId: row.fundingPeriodId,
          nextFundingTime: row.nextFundingTime
        };
        this.fundingHistoryReachable = true;
        /* A row exists only when the publisher supplied BOTH identity and rate.
           No Date.now cadence, implied next period, or synthetic curve. */
        if (row.fundingPeriodId !== null && row.fundingRate !== null) {
          this.fundingHistory = [{
            symbol: this.currentCoin.symbol,
            periodId: row.fundingPeriodId,
            rate: row.fundingRate,
            periodEnd: row.nextFundingTime
          }];
        }
      });
    },

    futuresTickerValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },

    positionPreviewValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },

    clearPositionPreview(resetLeverage) {
      clearTimeout(this._positionPreviewTimer);
      this._positionPreviewTimer = 0;
      this._positionPreviewSeq += 1;
      this.positionPreview = null;
      this.positionPreviewLoading = false;
      this.positionPreviewMessage = '';
      if (resetLeverage) this.positionLeverage = '';
    },

    schedulePositionPreview() {
      clearTimeout(this._positionPreviewTimer);
      this._positionPreviewTimer = 0;
      const seq = ++this._positionPreviewSeq;
      this.positionPreview = null;
      this.positionPreviewMessage = '';
      const request = positionPreviewWire.toRequest({
        symbol: this.currentCoin && this.currentCoin.symbol,
        side: this.side,
        size: String(this.form.amount || '').trim(),
        leverage: String(this.positionLeverage || '').trim()
      });
      if (!this.positionPreviewRequired || !this.ixToken || !request.ok) {
        this.positionPreviewLoading = false;
        return;
      }
      this.positionPreviewLoading = true;
      this._positionPreviewTimer = setTimeout(() => this.loadPositionPreview(request.body, seq), 250);
    },

    loadPositionPreview(body, seq) {
      this._positionPreviewTimer = 0;
      return rest('/positions/preview', { method: 'POST', token: this.ixToken, body: body }).then(res => {
        if (seq !== this._positionPreviewSeq) return;
        this.positionPreviewLoading = false;
        if (!res.ok) {
          this.positionPreview = null;
          this.positionPreviewMessage = res.message || this.$t('exchange.hlplus.previewUnavailable');
          return;
        }
        const gate = positionPreviewWire.acceptResponse(res.data);
        const sameInput = gate.ok && gate.data.symbol === body.symbol && gate.data.side === body.side &&
          ixMoney.compare(gate.data.size, body.size) === 0 && ixMoney.compare(gate.data.leverage, body.leverage) === 0;
        if (!sameInput) {
          this.positionPreview = null;
          this.positionPreviewMessage = this.$t('exchange.hlplus.previewInvalid');
          return;
        }
        this.positionPreview = gate.data;
        this.positionPreviewMessage = '';
      });
    },

    spotOrderPreviewInput() {
      var input = {
        symbol: this.currentCoin && this.currentCoin.symbol,
        side: this.side,
        type: this.orderType,
        amount: String(this.form.amount || '').trim(),
        price: String(this.form.price || '').trim(),
        stopPrice: String(this.form.stopPrice || '').trim(),
        timeInForce: this.timeInForce,
        postOnly: this.postOnly === true,
        reduceOnly: this.reduceOnly === true
      };
      if (this.orderType === 'trailing_stop') {
        input.trail = String(this.form.trail || '').trim();
        input.mark = String(this.form.mark || '').trim();
      }
      return input;
    },

    clearSpotOrderPreview() {
      clearTimeout(this._spotOrderPreviewTimer);
      this._spotOrderPreviewTimer = 0;
      this._spotOrderPreviewSeq += 1;
      this.spotOrderPreview = null;
      this.spotOrderPreviewLoading = false;
      this.spotOrderPreviewMessage = '';
    },

    scheduleSpotOrderPreview() {
      clearTimeout(this._spotOrderPreviewTimer);
      this._spotOrderPreviewTimer = 0;
      const seq = ++this._spotOrderPreviewSeq;
      this.spotOrderPreview = null;
      this.spotOrderPreviewMessage = '';
      const request = spotOrderPreviewWire.toRequest(this.spotOrderPreviewInput());
      if (!this.spotOrderPreviewRequired || !this.ixToken || !request.ok) {
        this.spotOrderPreviewLoading = false;
        return;
      }
      this.spotOrderPreviewLoading = true;
      this._spotOrderPreviewTimer = setTimeout(() => this.loadSpotOrderPreview(request.body, seq), 250);
    },

    loadSpotOrderPreview(body, seq) {
      this._spotOrderPreviewTimer = 0;
      return rest('/orders/preview', { method: 'POST', token: this.ixToken, body: body }).then(res => {
        if (seq !== this._spotOrderPreviewSeq) return;
        this.spotOrderPreviewLoading = false;
        if (!res.ok) {
          this.spotOrderPreview = null;
          this.spotOrderPreviewMessage = res.message || this.$t('exchange.residual.spotPreviewUnavailable');
          return;
        }
        const gate = spotOrderPreviewWire.acceptResponse(res.data);
        const sameAmount = gate.ok && ixMoney.compare(gate.data.amount, body.amount) === 0;
        const samePrice = !body.price
          ? gate.ok && (gate.data.price === null || gate.data.price === undefined)
          : gate.ok && ixMoney.compare(gate.data.price, body.price) === 0;
        const sameInput = gate.ok && gate.data.symbol === body.symbol && gate.data.side === body.side &&
          gate.data.type === body.type && sameAmount && samePrice;
        if (!sameInput) {
          this.spotOrderPreview = null;
          this.spotOrderPreviewMessage = this.$t('exchange.residual.spotPreviewInvalid');
          return;
        }
        this.spotOrderPreview = gate.data;
        this.spotOrderPreviewMessage = '';
      });
    },

    /** Public depth stream; empty snapshots stay empty and gaps resnapshot REST. */

    startDepthFeed() {
      this.stopDepthFeed();
      var marketId =
        (this.currentCoin && this.currentCoin.id) ||
        (this.marketMap &&
          this.marketMap[this.currentCoin.symbol] &&
          this.marketMap[this.currentCoin.symbol].id) ||
        (this.market && this.market.id) ||
        null;
      if (!marketId) {
        this.feedLive = false;
        return;
      }
      var self = this;
      this.depthFeed = ixDepthFeed.createDepthFeed({
        marketId: marketId,
        onLive: function (live) {
          self.feedLive = live;
        },
        onBook: function (plate) {
          /* Same path as REST getPlate — applyPlate is the shared seam. */
          self.bookLoading = false;
          self.bookReachable = true;
          self.bookReason = 'ok';
          self.bookMessage = '';
          self.applyPlate('SELL', ixTrade.toPlateItems(plate.asks || []));
          self.applyPlate('BUY', ixTrade.toPlateItems(plate.bids || []));
          if (self.mainTab === 'depth' && self.$refs.depthGraph) {
            self.$refs.depthGraph.draw({
              ask: { items: ixTrade.toPlateItems(plate.asks || []) },
              bid: { items: ixTrade.toPlateItems(plate.bids || []) }
            });
          }
        }
      });
    },

    stopDepthFeed() {
      if (this.depthFeed && typeof this.depthFeed.stop === 'function') {
        this.depthFeed.stop();
      }
      this.depthFeed = null;
      this.feedLive = false;
    },

    /* ── account ───────────────────────────────────────────────────────── */

    /**
     * The account panel — balances, open orders, closed orders, fills.
     *
     * GATED ON THE PLATFORM SESSION, NOT THE SHELL LOGIN. `isLogin` is the
     * vendored ucenter session; `ixToken` is the platform session svc-edge will
     * accept. They are different, and a reader signed in to the first sees a
     * named "{{ $t("exchange.residual.noPlatformSession") }}" refusal rather than an empty blotter that
     * reads as "you have no orders".
     */
    loadAccount() {
      if (!this.ixToken) {
        this.accountLoading = false;
        this.walletReachable = false;
        this.ordersReachable = false;
        this.openOrdersReachable = false;
        this.allOpenOrdersReachable = false;
        this.openOrders = [];
        this.allOpenOrders = [];
        this.accountError = this.$t('intafaced.trade.noSession');
        return;
      }
      if (!this.pendingOutcome) this.restorePendingOutcome();
      this.restoreBatchState();
      this.accountLoading = true;
      this.accountError = '';
      this.accountRefusal = '';
      this.walletReachable = false;
      this.ordersReachable = false;
      this.openOrdersReachable = false;
      this.allOpenOrdersReachable = false;
      this.allOpenOrders = [];
      this.positionsReachable = false;
      this.positionsMessage = '';
      this.positions = [];
      return Promise.all([
        this.getWallet(),
        this.getOpenOrders(),
        this.getAllOpenOrders(),
        this.getHistoryOrders(),
        this.getMyFills(),
        this.isPerpKind ? this.getPositions() : Promise.resolve()
      ]).then(() => {
        this.accountLoading = false;
        this.validateAmendStageFromRows();
        this.reconcilePendingOutcomeFromRows();
        this.reconcilePendingBatchFromRows();
        if (!this.walletReachable && !this.ordersReachable && (!this.isPerpKind || !this.positionsReachable)) {
          this.accountError =
            (this.accountRefusal || 'The platform did not answer.') +
            ' Balances and orders are not shown as zero — they are unknown.';
        }
      });
    },

    invalidateAmendStage(message) {
      this.amendOrder = null;
      this.pendingClientOrderId = '';
      this.form.amount = '';
      this.form.price = '';
      this.form.stopPrice = '';
      this.orderValidationError = '';
      this.liveAnnounce = message;
      this.$Notice.warning({ title: 'Staged reprice cleared', desc: message });
    },

    validateAmendStageFromRows() {
      if (!this.amendOrder) return;
      if (!this.openOrdersReachable) {
        this.invalidateAmendStage('The authoritative open-order row is unavailable. Reload the order before repricing.');
        return;
      }
      const selected = this.amendOrder;
      const fresh = (this.openOrders || []).filter(row => String(row.orderId) === String(selected.orderId))[0];
      if (!fresh || !this.canAmendOrder(fresh)) {
        this.invalidateAmendStage('The order is no longer open and untouched. Reload the blotter before repricing.');
        return;
      }
      const unchanged =
        String(fresh.price) === String(selected.price) &&
        String(fresh.amount) === String(selected.amount) &&
        String(fresh.tradedAmount || '0') === String(selected.tradedAmount || '0') &&
        String(fresh.direction) === String(selected.direction) &&
        String(fresh.type) === String(selected.type);
      if (!unchanged) {
        this.invalidateAmendStage('The authoritative order row changed. Review the refreshed row and stage a new amend.');
        return;
      }
      this.amendOrder = fresh;
    },

    /** Resolve unknown batch items from the same authoritative open/history reads. */
    reconcilePendingBatchFromRows() {
      var pending = this.pendingBatchOutcome;
      if (!pending || pending.action !== 'batch_submit' || !this.ordersReachable) return;
      var rows = (this.openOrders || []).concat(this.historyOrders || []);
      var unresolved = [];
      var self = this;
      (pending.items || []).forEach(function (item) {
        var found = null;
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i] && rows[i].clientOrderId === item.clientOrderId) {
            found = rows[i];
            break;
          }
        }
        var verdict = found ? ixOrderOutcome.classifyRow(found) : null;
        if (!found || !verdict || verdict.kind === 'unknown') {
          unresolved.push(item);
          return;
        }
        self.stagedBatchOrders = self.stagedBatchOrders.filter(function (draft) {
          return draft.clientOrderId !== item.clientOrderId;
        });
        self.batchResults = self.batchResults.map(function (result) {
          if (result.clientOrderId !== item.clientOrderId) return result;
          return Object.assign({}, result, { status: 'resolved', reconciliationRow: found });
        });
      });
      this.pendingBatchOutcome = unresolved.length ? Object.assign({}, pending, { items: unresolved }) : null;
      if (!unresolved.length) this.batchMessage = this.$t('exchange.residual.batchReconciled');
      this.persistBatchState();
    },

    /**
     * Resolve a pending write only from the existing private order reads.
     * Missing rows are still unknown: the desk never turns a read gap into a
     * clean rejection or sends a second POST/DELETE.
     */
    reconcilePendingOutcomeFromRows() {
      if (!this.pendingOutcome) return;
      if (this.pendingOutcome.action === 'cancel_all') {
        this.reconcileCancelAllOutcomeFromRows();
        return;
      }
      if (!this.ordersReachable) return;
      var clientOrderId = this.pendingOutcome.clientOrderId;
      var rows = (this.openOrders || []).concat(this.historyOrders || []);
      var found = null;
      for (var i = 0; i < rows.length; i += 1) {
        var targetOriginal = this.pendingOutcome.action === 'amend' && this.pendingOutcome.reconcileTarget === 'original';
        if (targetOriginal && this.pendingOutcome.orderId && rows[i].orderId === this.pendingOutcome.orderId) {
          found = rows[i];
          break;
        }
        if (!targetOriginal && clientOrderId && rows[i].clientOrderId === clientOrderId) {
          found = rows[i];
          break;
        }
        if (!targetOriginal && !clientOrderId && this.pendingOutcome.orderId && rows[i].orderId === this.pendingOutcome.orderId) {
          found = rows[i];
          break;
        }
      }
      if (!found) {
        this.reconcilingOutcome = false;
        this.pendingOutcome = Object.assign({}, this.pendingOutcome, { phase: 'unknown' });
        this.persistPendingOutcome();
        return;
      }
      var rowVerdict = ixOrderOutcome.classifyRow(found);
      if (rowVerdict && rowVerdict.kind === 'unknown') {
        this.pendingOutcome = Object.assign({}, this.pendingOutcome, { phase: 'unknown', verdict: rowVerdict });
        this.persistPendingOutcome();
        return;
      }
      /* A cancel that is still open is not a cancellation success. Keep the
         explicit unknown state and block another DELETE until a later read. */
      if (this.pendingOutcome.action === 'cancel' && found.status === 'TRADING') {
        this.pendingOutcome = Object.assign({}, this.pendingOutcome, {
          phase: 'unknown',
          lastReadStatus: 'TRADING'
        });
        this.persistPendingOutcome();
        return;
      }
      if (this.pendingOutcome.action === 'amend' && this.pendingOutcome.path === 'NATIVE_AMEND') {
        /* A live row of the same id does not prove the PATCH landed. */
        this.pendingOutcome = Object.assign({}, this.pendingOutcome, {
          phase: 'unknown',
          lastReadStatus: found.status
        });
        this.persistPendingOutcome();
        return;
      }
      if (this.pendingOutcome.action === 'amend' && this.pendingOutcome.reconcileTarget === 'original') {
        if (found.status === 'TRADING') {
          this.pendingOutcome = Object.assign({}, this.pendingOutcome, {
            phase: 'unknown',
            lastReadStatus: 'TRADING'
          });
          this.persistPendingOutcome();
          return;
        }
        /* CANCEL_UNKNOWN proves only that no replacement was safe to submit;
           once the original is read as cancelled, close the saga honestly. */
        this.pendingOutcome = null;
        this.reconcilingOutcome = false;
        this.pendingClientOrderId = '';
        this.amendOrder = null;
        this.persistPendingOutcome();
        this.liveAnnounce = this.$t('exchange.residual.amendCancelReconciled');
        this.$Notice.warning({ title: this.liveAnnounce, desc: this.$t('exchange.residual.amendNotSubmitted') });
        return;
      }
      var action = this.pendingOutcome.action;
      this.pendingOutcome = null;
      this.reconcilingOutcome = false;
      this.pendingClientOrderId = '';
      if (action === 'amend') this.amendOrder = null;
      this.orderValidationError = '';
      this.persistPendingOutcome();
      this.accountTab = action === 'cancel' ? 'history' : (found.status === 'TRADING' ? 'open' : 'history');
      this.liveAnnounce = action === 'cancel'
        ? this.$t('exchange.residual.cancelReconciled')
        : this.$t('exchange.residual.submitReconciled');
      this.$Notice.success({ title: this.liveAnnounce, desc: found.orderId || found.symbol });
    },

    /**
     * Mass-cancel reconciliation is deliberately narrower than the ordinary
     * order saga: only the successful, scope-matching open-order read can
     * prove that every pre-command target has left the open blotter. A failed
     * read never becomes an inferred cancellation, and surviving targets keep
     * the outcome unknown while individual row actions remain available.
     */
    reconcileCancelAllOutcomeFromRows() {
      var pending = this.pendingOutcome;
      if (!pending || pending.action !== 'cancel_all') return;
      var scope = pending.scope === 'all' ? 'all' : 'symbol';
      if (scope === 'symbol' && pending.symbol !== this.currentCoin.symbol) {
        /* A symbol-scoped target belongs to its original pair. The new pair's
           successful read is not evidence about those IDs. */
        this.pendingOutcome = Object.assign({}, pending, { phase: 'unknown' });
        this.persistPendingOutcome();
        return;
      }
      var reachable = scope === 'all' ? this.allOpenOrdersReachable : this.openOrdersReachable;
      if (!reachable) {
        this.pendingOutcome = Object.assign({}, pending, { phase: 'unknown' });
        this.persistPendingOutcome();
        return;
      }
      var rows = scope === 'all' ? (this.allOpenOrders || []) : (this.openOrders || []);
      if (rows.length === 500) {
        /* A capped successful read cannot prove that every target is gone. */
        this.pendingOutcome = Object.assign({}, pending, { phase: 'unknown' });
        this.persistPendingOutcome();
        return;
      }
      var openIds = {};
      rows.forEach(function(row) {
        if (row && row.orderId) openIds[String(row.orderId)] = true;
      });
      var targetIds = Array.isArray(pending.targetOrderIds) ? pending.targetOrderIds : [];
      var remaining = targetIds.filter(function(id) { return openIds[String(id)]; });
      if (remaining.length) {
        this.pendingOutcome = Object.assign({}, pending, {
          phase: 'unknown',
          remainingTargetOrderIds: remaining,
          lastReadStatus: 'TRADING'
        });
        this.persistPendingOutcome();
        return;
      }
      this.pendingOutcome = null;
      this.reconcilingOutcome = false;
      this.pendingClientOrderId = '';
      this.orderValidationError = '';
      this.persistPendingOutcome();
      this.accountTab = 'open';
      this.liveAnnounce = this.$t('exchange.residual.cancelAllReconciled');
      this.$Notice.success({ title: this.liveAnnounce, desc: this.$t('exchange.residual.cancelAllReconciledDesc', { count: targetIds.length }) });
    },

    reconcilePendingOutcome() {
      if (!this.pendingOutcome || this.reconcilingOutcome) return;
      this.reconcilingOutcome = true;
      this.pendingOutcome = Object.assign({}, this.pendingOutcome, { phase: 'reconciling' });
      this.persistPendingOutcome();
      this.accountTab = this.pendingOutcome.action === 'cancel' ? 'open' : 'open';
      this.loadAccount();
    },

    /** Remember the first named refusal so the panel can quote a reason. */
    noteRefusal(res) {
      if (!res.ok && !this.accountRefusal) {
        this.accountRefusal = res.message || '';
      }
    },

    /**
     * Balances — `GET /api/v1/account/balance`, the ledger projection.
     *
     * ONE CALL, NOT TWO. The vendor read a per-asset wallet endpoint twice
     * (base and quote) and only trusted the pair when BOTH legs answered,
     * because one dead leg had painted a false available 0. Our endpoint
     * returns every asset in one answer, so that failure mode is gone: either
     * we have the whole picture or we have none of it.
     *
     * An asset with no ledger row is NOT zero — it means the ledger has never
     * held it for this user. `freeBalanceOf` returns null and the ticket says
     * the balance is unknown rather than sizing an order against a fiction.
     */
    getWallet() {
      this.walletReachable = false;
      return rest('/account/balance', { token: this.ixToken }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) {
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.balances, res.data);
        if (!gate.ok) {
          this.noteRefusal(gate);
          return;
        }
        const rows = ixTrade.toBalanceRows(gate.data);
        this.balances = rows;
        this.wallet = {
          base: ixTrade.freeBalanceOf(rows, this.currentCoin.base),
          coin: ixTrade.freeBalanceOf(rows, this.currentCoin.coin)
        };
        this.walletReachable = true;
      });
    },

    getOpenOrders() {
      this.openOrdersReachable = false;
      return rest('/orders/open', {
        token: this.ixToken,
        query: { symbol: this.currentCoin.symbol, limit: 500 }
      }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) {
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.orders, res.data);
        if (!gate.ok) {
          this.noteRefusal(gate);
          return;
        }
        // A 200 with [] is "you have none" — a real answer, so reachable.
        this.openOrders = ixTrade.toDeskOrders(gate.data);
        this.openOrdersReachable = true;
        this.ordersReachable = true;
      });
    },

    /** All-market read used only to make the across-markets scope truthful. */
    getAllOpenOrders() {
      this.allOpenOrdersReachable = false;
      return rest('/orders/open', { token: this.ixToken, query: { limit: 500 } }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) return;
        const gate = ixTrade.accept(ixTrade.schemas.orders, res.data);
        if (!gate.ok) {
          this.noteRefusal(gate);
          return;
        }
        this.allOpenOrders = ixTrade.toDeskOrders(gate.data);
        this.allOpenOrdersReachable = true;
      });
    },

    getHistoryOrders() {
      return rest('/orders/closed', {
        token: this.ixToken,
        query: { symbol: this.currentCoin.symbol, limit: 100 }
      }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) {
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.orders, res.data);
        if (!gate.ok) {
          this.noteRefusal(gate);
          return;
        }
        this.historyOrders = ixTrade.toDeskOrders(gate.data);
        this.ordersReachable = true;
      });
    },

    /**
     * Canonical principal-owned positions. A 200 [] is empty; a refused or
     * malformed answer remains unavailable and never becomes an empty blotter.
     */
    getPositions() {
      this.positionsReachable = false;
      this.positionsMessage = '';
      return rest('/positions', { token: this.ixToken }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) {
          this.positions = [];
          this.positionsMessage = res.message || '';
          return;
        }
        const rows = Array.isArray(res.data) ? res.data : null;
        const decimal = value => typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
        const nullableDecimal = value => value === null || decimal(value);
        const valid = rows && rows.every(row => row && typeof row === 'object' &&
          typeof row.id === 'string' && typeof row.symbol === 'string' &&
          (row.side === 'long' || row.side === 'short') &&
          (row.status === 'open' || row.status === 'closing') &&
          (row.marginMode === 'isolated' || row.marginMode === 'cross') &&
          decimal(row.contracts) && decimal(row.entryPrice) && decimal(row.leverage) &&
          nullableDecimal(row.markPrice) && nullableDecimal(row.unrealizedPnl) &&
          nullableDecimal(row.initialMargin) &&
          nullableDecimal(row.liquidationPrice));
        if (!valid) {
          this.positions = [];
          this.positionsMessage = this.$t('exchange.hlplus.positionsUnavailable');
          return;
        }
        this.positions = rows;
        this.positionsReachable = true;
      });
    },

    positionValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },

    isolatedInitialMargin(row) {
      if (!row || row.marginMode !== 'isolated') return '—';
      return this.positionValue(row.initialMargin);
    },

    positionSideLabel(side) {
      return side === 'long' ? this.$t('exchange.hlplus.sideLong') : this.$t('exchange.hlplus.sideShort');
    },

    positionPnlClass(value) {
      if (value === null || value === undefined || value === '') return 'ix-dim';
      if (String(value).charAt(0) === '-') return 'ix-down';
      return String(value) === '0' ? '' : 'ix-up';
    },

    /**
     * My fills — `GET /api/v1/account/trades`.
     *
     * A SEPARATE CALL, WHICH IT DID NOT USED TO BE. The vendor's Trade History
     * tab read `order.detail[]` embedded in each history order. Our order wire
     * carries no nested fills, so deriving the tab from it would have shown an
     * empty fill list for orders that genuinely traded — the exact "zero that
     * reads as a real value" this work exists to remove.
     */
    getMyFills() {
      return rest('/account/trades', {
        token: this.ixToken,
        query: { symbol: this.currentCoin.symbol, limit: 100 }
      }).then(res => {
        this.noteRefusal(res);
        if (!res.ok) {
          this.fillsReachable = false;
          return;
        }
        const gate = ixTrade.accept(ixTrade.schemas.trades, res.data);
        if (!gate.ok) {
          this.noteRefusal(gate);
          this.fillsReachable = false;
          return;
        }
        this.myFills = ixTrade.toDeskFills(gate.data);
        this.fillsReachable = true;
      });
    },

    /* ── interactions ──────────────────────────────────────────────────── */

    quoteConvert() {
      var qty = String(this.convertQty == null ? '' : this.convertQty).trim();
      if (!this.ixToken) {
        this.convertError = this.$t('exchange.convert.signIn');
        return;
      }
      if (!this.currentCoin.symbol || !ixMoney.isPositive(qty)) {
        this.convertError = this.$t('exchange.convert.invalidQuantity');
        return;
      }
      this.convertLoading = true;
      this.convertError = '';
      this.convertQuote = null;
      this.convertResult = null;
      query('trade', 'convert.quote', {
        symbol: this.currentCoin.symbol,
        side: this.convertSide,
        qty: qty
      }, this.ixToken).then(res => {
        this.convertLoading = false;
        if (!res || !res.ok) {
          this.convertError = res && res.message ? res.message : this.$t('exchange.convert.refused');
          return;
        }
        this.convertQuote = res.data;
      });
    },

    executeConvert() {
      if (!this.convertCanExecute || this.convertExecuting) return;
      var qty = String(this.convertQty).trim();
      this.convertExecuting = true;
      this.convertError = '';
      mutate('trade', 'convert.execute', {
        symbol: this.currentCoin.symbol,
        side: this.convertSide,
        qty: qty,
        clientConvertId: this.convertClientId()
      }, this.ixToken).then(res => {
        this.convertExecuting = false;
        if (!res || !res.ok) {
          this.convertError = res && res.message ? res.message : this.$t('exchange.convert.refused');
          return;
        }
        this.convertResult = {
          status: String(res.data && res.data.status || ''),
          orderId: String(res.data && res.data.id || '')
        };
        this.convertQuote = null;
      });
    },

    convertClientId() {
      var suffix = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return 'convert:' + suffix.slice(0, 40);
    },

    copyPermittedMarketList() {
      return String(this.copyPermittedMarkets == null ? '' : this.copyPermittedMarkets)
        .split(/[,\s]+/)
        .map(function (item) { return String(item).trim(); })
        .filter(Boolean);
    },

    copyIsoDatetime(value) {
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(String(value || ''));
    },

    copyRefuseLabel(res) {
      var msg = res && res.message ? String(res.message) : '';
      var code = res && res.intafacedCode ? String(res.intafacedCode) : '';
      var blob = code + ' ' + msg;
      var named = '';
      if (/copy_jurisdiction_blank|DIRECTION §8|served-jurisdiction/i.test(blob)) {
        named = 'trade.copy_jurisdiction_blank';
      } else if (/copy_place_disabled|placeMirror is refuse-closed/i.test(blob)) {
        named = 'trade.copy_place_disabled';
      } else if (/copy_session_key_missing|session-key/i.test(blob)) {
        named = 'trade.copy_session_key_missing';
      } else if (/copy_flatten_refused|flatten is refuse-closed/i.test(blob)) {
        named = 'trade.copy_flatten_refused';
      } else if (/copy_flatten_drift|close drifted/i.test(blob)) {
        named = 'trade.copy_flatten_drift';
      } else if (/copy_flatten_unavailable|close is unavailable/i.test(blob)) {
        named = 'trade.copy_flatten_unavailable';
      } else if (/copy_paused|Copy is paused/i.test(blob)) {
        named = 'trade.copy_paused';
      } else if (/copy_stopped|Copy is stopped/i.test(blob)) {
        named = 'trade.copy_stopped';
      } else if (/copy_detached|Copy is detached/i.test(blob)) {
        named = 'trade.copy_detached';
      } else if (/envelope|invalid|required|permitted|datetime/i.test(blob)) {
        named = 'trade.copy_envelope_invalid';
      }
      if (named && msg.indexOf(named) === -1) {
        return named + ' — ' + (msg || this.$t('intafaced.exchange.copy.refused'));
      }
      if (msg) return msg;
      return this.$t('intafaced.exchange.copy.refused');
    },

    loadCopyFollows() {
      if (!this.ixToken) {
        this.copyFollows = [];
        this.copyFollowsReachable = false;
        return;
      }
      this.copyFollowsLoading = true;
      query('trade', 'copy.listMyFollows', undefined, this.ixToken).then(res => {
        this.copyFollowsLoading = false;
        if (!res || !res.ok) {
          this.copyFollowsReachable = false;
          this.copyFollows = [];
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.copyFollowsReachable = true;
        this.copyFollows = Array.isArray(res.data) ? res.data : [];
      });
    },

    submitCopyFollow() {
      if (!this.ixToken) {
        this.copyError = this.$t('intafaced.exchange.copy.signIn');
        return;
      }
      if (this.copyFollowing) return;
      var leaderId = String(this.copyLeaderId == null ? '' : this.copyLeaderId).trim();
      var region = String(this.copyRegion == null ? '' : this.copyRegion).trim();
      var permittedMarkets = this.copyPermittedMarketList();
      var copyMaxNotionalPerOrder = String(this.copyMaxNotionalPerOrder == null ? '' : this.copyMaxNotionalPerOrder).trim();
      var copyMaxAggregateExposure = String(this.copyMaxAggregateExposure == null ? '' : this.copyMaxAggregateExposure).trim();
      var expiresAt = String(this.copyExpiresAt == null ? '' : this.copyExpiresAt).trim();
      if (
        !leaderId ||
        !region ||
        permittedMarkets.length === 0 ||
        !ixMoney.isPositive(copyMaxNotionalPerOrder) ||
        !ixMoney.isPositive(copyMaxAggregateExposure) ||
        !this.copyIsoDatetime(expiresAt)
      ) {
        this.copyError = this.$t('intafaced.exchange.copy.invalid');
        return;
      }
      this.copyFollowing = true;
      this.copyError = '';
      mutate('trade', 'copy.follow', {
        leaderId: leaderId,
        region: region,
        permittedMarkets: permittedMarkets,
        maxNotionalPerOrder: copyMaxNotionalPerOrder,
        maxAggregateExposure: copyMaxAggregateExposure,
        expiresAt: expiresAt
      }, this.ixToken).then(res => {
        this.copyFollowing = false;
        if (!res || !res.ok) {
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.loadCopyFollows();
      });
    },

    unfollowCopy(followId) {
      var id = String(followId || '').trim();
      if (!this.ixToken || !id || this.copyUnfollowingId) return;
      this.copyUnfollowingId = id;
      this.copyError = '';
      mutate('trade', 'copy.unfollow', { followId: id }, this.ixToken).then(res => {
        this.copyUnfollowingId = '';
        if (!res || !res.ok) {
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.loadCopyFollows();
      });
    },

    /**
     * M26 — pause/stop/detach/flatten (and resume) via copy.* only.
     * Never desk closePosition / DELETE /positions. Unwired flatten is a named refuse.
     */
    copyControl(action, followId) {
      var procedures = {
        pause: 'copy.pause',
        resume: 'copy.resume',
        stop: 'copy.stop',
        detach: 'copy.detach',
        flatten: 'copy.flatten'
      };
      var procedure = procedures[action];
      var id = String(followId || '').trim();
      if (!procedure || !this.ixToken || !id || this.copyActingId) return;
      this.copyActingId = action + ':' + id;
      this.copyError = '';
      mutate('trade', procedure, { followId: id }, this.ixToken).then(res => {
        this.copyActingId = '';
        if (!res || !res.ok) {
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.loadCopyFollows();
      });
    },

    grantCopySession(followId) {
      var id = String(followId || '').trim();
      if (!this.ixToken || !id || this.copyGrantingId) return;
      this.copyGrantingId = id;
      this.copyError = '';
      mutate('trade', 'copy.grantSessionKey', { followId: id }, this.ixToken).then(res => {
        this.copyGrantingId = '';
        if (!res || !res.ok) {
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.copyPlaceFollowId = id;
        this.loadCopyFollows();
      });
    },

    killCopySession(followId) {
      var id = String(followId || '').trim();
      if (!this.ixToken || !id || this.copyKillingId) return;
      this.copyKillingId = id;
      this.copyError = '';
      mutate('trade', 'copy.killSessionKey', { followId: id }, this.ixToken).then(res => {
        this.copyKillingId = '';
        if (!res || !res.ok) {
          this.copyError = this.copyRefuseLabel(res);
          return;
        }
        this.loadCopyFollows();
      });
    },

    placeCopyMirror() {
      if (!this.ixToken) {
        this.copyError = this.$t('intafaced.exchange.copy.signIn');
        return;
      }
      if (this.copyPlacing) return;
      var followId = String(this.copyPlaceFollowId == null ? '' : this.copyPlaceFollowId).trim();
      var fillId = String(this.copyPlaceFillId == null ? '' : this.copyPlaceFillId).trim();
      var marketId = String(this.copyPlaceMarketId == null ? '' : this.copyPlaceMarketId).trim();
      var qty = String(this.copyPlaceQty == null ? '' : this.copyPlaceQty).trim();
      var notional = String(this.copyPlaceNotional == null ? '' : this.copyPlaceNotional).trim();
      if (!followId || !fillId || !marketId || !ixMoney.isPositive(qty) || !ixMoney.isPositive(notional)) {
        this.copyError = this.$t('intafaced.exchange.copy.invalidPlace');
        return;
      }
      this.copyPlacing = true;
      this.copyError = '';
      var token = this.ixToken;
      mutate('trade', 'copy.planMirror', {
        followId: followId,
        fillId: fillId,
        marketId: marketId,
        side: 'buy',
        qty: qty,
        notional: notional
      }, token).then(planRes => {
        if (!planRes || !planRes.ok) {
          this.copyPlacing = false;
          this.copyError = this.copyRefuseLabel(planRes);
          return;
        }
        return mutate('trade', 'copy.placeMirror', {
          followId: followId,
          fillId: fillId,
          leaderPaper: false
        }, token).then(placeRes => {
          this.copyPlacing = false;
          if (!placeRes || !placeRes.ok) {
            this.copyError = this.copyRefuseLabel(placeRes);
            return;
          }
          this.loadCopyFollows();
        });
      }).catch(function () {
        this.copyPlacing = false;
      }.bind(this));
    },

    openPair(row) {
      this.closeMarkets(false);
      if (!row || row.symbol === this.currentCoin.symbol) {
        return;
      }
      this.$router.push({ name: 'ExchangePair', params: { pair: row.href } });
    },

    /**
     * Fold the book into N×10^(-scale) buckets. N=1 is the raw book.
     *
     * NOT DISPLAY-ONLY, WHICH IS WHY IT IS DECIMAL NOW. A grouped row is still
     * clickable, and `useBookPrice` copies its price into the order form — so
     * the bucket price computed here can reach `POST /orders`. It used to be
     * `Math.floor(px / step) * step` on floats, then `toFixed`: a bucket
     * boundary that lands one ulp low puts the row in the wrong bucket, and the
     * `toFixed` re-rounds the boundary itself. Every step below is BigNumber and
     * every price out is a decimal string.
     *
     * Bids fold DOWN and asks fold UP, both away from the spread, so a grouped
     * level never claims a better price than the depth behind it.
     */
    groupPlate(rows, side) {
      var list = rows || [];
      var g = Math.floor(Number(this.bookGroup) || 1);
      if (g <= 1 || list.length === 0) return list;
      /* Scale is a property of the instrument. No published precision → leave
         the book ungrouped rather than invent a two-decimal bucket width. */
      var scale = this.baseCoinScale;
      if (scale == null || !isFinite(Number(scale))) return list;
      /* The bucket width as a decimal string: g ticks of 10^-scale. */
      var step = ixMoney.multiply(String(g), '1e-' + scale, scale);
      if (step === null || !ixMoney.isPositive(step)) return list;
      var map = {};
      var order = [];
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        /* divide(_, _, 0) truncates toward zero, and book prices are positive,
           so this is floor. Null means the level was unreadable — drop it
           rather than folding it into a bucket it does not belong to. */
        var index = ixMoney.divide(row.price, step, 0);
        if (index === null) continue;
        if (side !== 'bid' && ixMoney.compare(ixMoney.multiply(index, step, scale), row.price) !== 0) {
          /* An ask that does not sit exactly on a boundary folds up. */
          index = ixMoney.add(index, '1');
        }
        var key = ixMoney.multiply(index, step, scale);
        if (key === null) continue;
        if (!map[key]) {
          map[key] = { price: key, amount: '0', totalAmount: '0' };
          order.push(key);
        }
        /* Preserves the vendor's summing semantics exactly — see the PR note on
           the cumulative column, which this change deliberately does not alter. */
        map[key].amount = ixMoney.add(map[key].amount, row.amount) || map[key].amount;
        var cumulative = row.totalAmount != null ? row.totalAmount : row.amount;
        map[key].totalAmount = ixMoney.add(map[key].totalAmount, cumulative) || map[key].totalAmount;
      }
      return order.map(function (k) { return map[k]; });
    },

    /**
     * Click a book row → its price in the limit input.
     *
     * THE VENUE'S OWN DECIMAL STRING, truncated to the market's price
     * precision. This was `fmt(parseFloat(row.price), scale)`, which both
     * re-encoded the quote through a binary double and ROUNDED it — 1.45 at one
     * place became 1.5, and the buy button then offered a price the venue never
     * quoted. `bookPriceForForm` answers null for a level that is not real
     * depth, and null leaves the form untouched rather than blanking it.
     */
    useBookPrice(row) {
      const price = ixMoney.bookPriceForForm(row.price, this.baseCoinScale);
      if (price === null) {
        return;
      }
      this.orderType = 'LIMIT_PRICE';
      this.form.price = price;
      this.clearPendingOrderIdentity();
      this.clearPendingScaleIdentity();
      this.applyPercent();
    },

    setSide(side) {
      if (this.advancedPlanLocked) return this.warn(this.$t('exchange.hlplus.partialPlanLocked'));
      this.side = side;
      this.clearPendingOrderIdentity();
      this.clearPendingAlgoIdentity();
      this.clearPendingAdvancedIdentity();
      this.percent = 0;
      this.form.amount = '';
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },

    setOrderType(type) {
      if (this.advancedPlanLocked) return this.warn(this.$t('exchange.hlplus.partialPlanLocked'));
      const helperDoors = ['aon', 'bracket', 'close', 'collar', 'GTD', 'iceberg', 'oco', 'peg', 'rfq'];
      const helperDoor = helperDoors.indexOf(type) !== -1 ? type : '';
      this.ticketCapability = helperDoor;
      this.orderType = helperDoor ? 'LIMIT_PRICE' : type;
      if (helperDoor) this.ticketMoreOpen = true;
      if (helperDoor === 'GTD') this.timeInForce = 'GTD';
      else if (this.timeInForce === 'GTD' || this.timeInForce === 'GTT') this.timeInForce = 'GTC';
      this.clearPendingOrderIdentity();
      this.clearPendingAlgoIdentity();
      this.clearPendingAdvancedIdentity();
      if (this.wireOrderType === 'market') {
        this.timeInForce = 'IOC';
        this.postOnly = false;
      } else if (this.timeInForce === 'IOC' && type !== 'stop') {
        this.timeInForce = 'GTC';
      }
      this.percent = 0;
      this.form.amount = '';
      this.$nextTick(function () {
        this.syncTicketCapability(helperDoor);
      });
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },

    syncTicketCapability(type) {
      if (typeof document === 'undefined') return;
      const checks = {
        aon: 'ix-ticket-aon',
        bracket: 'ix-ticket-bracket',
        close: 'ix-ticket-close',
        collar: 'ix-ticket-collar',
        iceberg: 'ix-ticket-iceberg',
        peg: 'ix-ticket-peg'
      };
      Object.keys(checks).forEach(function (door) {
        const input = document.getElementById(checks[door]);
        if (input) input.checked = door === type && type !== 'peg';
      });
    },

    setPercent(value) {
      this.percent = value;
      this.clearPendingOrderIdentity();
      this.clearPendingAlgoIdentity();
      this.clearPendingAdvancedIdentity();
      this.applyPercent();
    },

    /**
     * The size behind the 25/50/75/100% buttons — the second half of the money
     * path, and the one that used to be float all the way through.
     *
     * It was `(availableBalanceNum * percent) / 100` on a parsed balance, then
     * `budget / price`, then `Math.floor(n * 10**scale) / 10**scale`. Three
     * lossy operations, and the result went into `form.amount` and straight out
     * to `POST /orders`. A 100% sell has to come out as a size the ledger's own
     * balance covers exactly: one ulp over is a rejection the trader cannot
     * explain, one ulp under quietly strands dust.
     *
     * `percentSize` takes the balance as the STRING the ledger sent, does every
     * step in BigNumber and truncates once at the end. Null in means an unknown
     * balance or an unusable price, and null clears the box — it never sizes
     * against a balance that does not exist.
     */
    applyPercent() {
      this.clearPendingAlgoIdentity();
      if (!this.canSize || this.percent <= 0) {
        if (this.percent <= 0) {
          this.form.amount = '';
          this.schedulePositionPreview();
          this.scheduleSpotOrderPreview();
        }
        return;
      }
      const quoteSized = this.quoteSized;
      const size = ixMoney.percentSize({
        balance: this.availableBalance,
        percent: this.percent,
        scale: quoteSized ? this.baseCoinScale : this.coinScale,
        /* A limit/market BUY sized in the base asset spends quote at the limit
           price. A SELL and a quote-sized market BUY are already denominated in
           the asset being sized, so there is nothing to divide by. */
        divideBy: quoteSized || this.side === 'SELL' ? null : this.form.price
      });
      this.form.amount = size === null ? '' : size;
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },

    onPriceInput() {
      this.form.price = this.clamp(this.form.price, this.baseCoinScale);
      this.clearPendingOrderIdentity();
      this.clearPendingScaleIdentity();
      this.orderValidationError = '';
      if (this.percent > 0) {
        this.applyPercent();
      } else {
        this.scheduleSpotOrderPreview();
      }
    },

    onAmountInput() {
      this.form.amount = this.clamp(this.form.amount, this.quoteSized ? this.baseCoinScale : this.coinScale);
      this.clearPendingOrderIdentity();
      this.clearPendingAlgoIdentity();
      this.clearPendingAdvancedIdentity();
      this.percent = 0;
      this.orderValidationError = '';
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },

    onPositionLeverageInput() {
      this.positionLeverage = String(this.positionLeverage || '').trim();
      this.clearPendingOrderIdentity();
      this.orderValidationError = '';
      this.schedulePositionPreview();
    },

    onReduceOnlyChange() {
      this.clearOrderSubmissionIdentity();
      this.schedulePositionPreview();
      this.scheduleSpotOrderPreview();
    },

    onStopPriceInput() {
      this.form.stopPrice = this.clamp(this.form.stopPrice, this.baseCoinScale);
      this.clearPendingOrderIdentity();
      this.orderValidationError = '';
      this.scheduleSpotOrderPreview();
    },

    onTrailInput() {
      this.form.trail = this.clamp(this.form.trail, this.baseCoinScale);
      this.clearPendingOrderIdentity();
      this.orderValidationError = '';
      this.scheduleSpotOrderPreview();
    },

    onMarkInput() {
      this.form.mark = this.clamp(this.form.mark, this.baseCoinScale);
      this.clearPendingOrderIdentity();
      this.orderValidationError = '';
      this.scheduleSpotOrderPreview();
    },

    clearPendingOrderIdentity() {
      /* An unresolved command owns this retry key until reads reconcile it. */
      if (this.pendingOutcome) return;
      this.pendingClientOrderId = '';
    },

    pendingOutcomeStorageKey(outcome) {
      var owner = subjectOf(this.ixToken) || 'session';
      var scope = outcome && outcome.action === 'cancel_all' && outcome.scope === 'all'
        ? 'ALL'
        : (outcome && outcome.symbol) || this.currentCoin.symbol;
      return 'ix.order-outcome.v1:' + owner + ':' + scope;
    },

    batchStorageKey() {
      var owner = subjectOf(this.ixToken) || 'session';
      var symbol = (this.currentCoin && this.currentCoin.symbol) || 'unknown';
      return 'ix.batch-order.v1:' + owner + ':' + symbol;
    },

    persistBatchState() {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      try {
        if (!this.stagedBatchOrders.length && !this.pendingBatchOutcome && !this.batchResults.length) {
          window.sessionStorage.removeItem(this.batchStorageKey());
          return;
        }
        window.sessionStorage.setItem(this.batchStorageKey(), JSON.stringify({
          drafts: this.stagedBatchOrders,
          pending: this.pendingBatchOutcome,
          results: this.batchResults
        }));
      } catch (e) {
        /* Draft persistence is recovery evidence, never a write gate. */
      }
    },

    restoreBatchState() {
      if (this.batchStateLoaded || typeof window === 'undefined' || !window.sessionStorage) return;
      this.batchStateLoaded = true;
      try {
        var raw = window.sessionStorage.getItem(this.batchStorageKey());
        var saved = raw ? JSON.parse(raw) : null;
        if (!saved || typeof saved !== 'object') return;
        var drafts = Array.isArray(saved.drafts) ? saved.drafts : [];
        this.stagedBatchOrders = drafts.filter(function (draft) {
          return draft && (draft.status === 'staged' || draft.status === 'refused' || draft.status === 'unknown') &&
            ixBatchOrder.validateDrafts([draft]).ok;
        });
        this.pendingBatchOutcome = saved.pending && saved.pending.action === 'batch_submit' &&
          Array.isArray(saved.pending.items) ? saved.pending : null;
        this.batchResults = Array.isArray(saved.results) ? saved.results : [];
      } catch (e) {
        this.stagedBatchOrders = [];
        this.pendingBatchOutcome = null;
        this.batchResults = [];
      }
    },

    batchDraftStatus(draft) {
      if (!draft) return '';
      if (draft.status === 'staged') return this.$t('exchange.residual.batchStatusStaged');
      if (draft.status === 'refused') return this.$t('exchange.residual.batchStatusRefused');
      if (draft.status === 'unknown') return this.$t('exchange.residual.batchStatusUnknown');
      if (draft.status === 'resolved') return this.$t('exchange.residual.batchStatusReconciled');
      return draft.status;
    },

    stageCurrentBatchOrder() {
      if (!this.batchEligible) return this.warn(this.$t('exchange.residual.batchSpotOnly'));
      if (this.batchStageDisabled) {
        if (this.stagedBatchOrders.length >= MAX_BATCH_ORDERS) {
          return this.warn(this.$t('exchange.residual.batchCapReached', { max: MAX_BATCH_ORDERS }));
        }
        return;
      }
      var fieldErr = this.validateOrderFields();
      if (fieldErr) {
        this.focusOrderError(fieldErr);
        return this.warn(fieldErr);
      }
      var body = ixTrade.toCreateOrderBody({
        symbol: this.currentCoin.symbol,
        type: this.orderType,
        side: this.side,
        amount: String(this.form.amount).trim(),
        price: String(this.form.price).trim(),
        timeInForce: this.timeInForce,
        postOnly: this.postOnly || this.timeInForce === 'PO',
        reduceOnly: false,
        clientOrderId: this.nextClientOrderId()
      });
      var draft = ixBatchOrder.createDraft(body);
      var check = ixBatchOrder.validateDrafts(this.stagedBatchOrders.concat([draft]));
      if (!check.ok) return this.warn(check.message);
      this.stagedBatchOrders.push(draft);
      this.batchMessage = this.$t('exchange.residual.batchStaged', { id: draft.clientOrderId });
      this.persistBatchState();
    },

    removeBatchDraft(index) {
      var draft = this.stagedBatchOrders[index];
      if (!draft || draft.status === 'unknown') return;
      this.stagedBatchOrders.splice(index, 1);
      this.persistBatchState();
    },

    abandonBatchDraft(index) {
      var draft = this.stagedBatchOrders[index];
      if (!draft || draft.status !== 'unknown') return;
      this.$Modal.confirm({
        title: this.$t('exchange.residual.abandonBatchUnknownTitle'),
        content: this.$t('exchange.residual.abandonBatchUnknownCopy', { id: draft.clientOrderId }),
        okText: this.$t('exchange.residual.abandonBatchUnknown'),
        cancelText: this.$t('exchange.terminal.cancel'),
        onOk: () => {
          this.stagedBatchOrders.splice(index, 1);
          if (this.pendingBatchOutcome && Array.isArray(this.pendingBatchOutcome.items)) {
            this.pendingBatchOutcome.items = this.pendingBatchOutcome.items.filter(function (item) {
              return item.clientOrderId !== draft.clientOrderId;
            });
            if (!this.pendingBatchOutcome.items.length) this.pendingBatchOutcome = null;
          }
          this.batchMessage = this.$t('exchange.residual.batchUnknownAbandoned', { id: draft.clientOrderId });
          this.persistBatchState();
        }
      });
    },

    submitBatchOrders() {
      if (this.submitting || this.pendingOutcome || !this.batchStagedCount) return;
      var drafts = this.stagedBatchOrders.filter(function (draft) { return draft.status === 'staged'; });
      var built = ixBatchOrder.buildPayload(drafts);
      if (!built.ok) return this.warn(built.message);
      this.submitting = true;
      return rest('/orders/batch', { method: 'POST', token: this.ixToken, body: built.payload }).then(res => {
        this.submitting = false;
        var verdict = ixBatchOrder.classifyResponse(res, drafts);
        if (!verdict || !verdict.items) {
          this.batchMessage = (verdict && verdict.message) || this.$t('exchange.residual.batchUnknownCopy');
          return;
        }
        this.batchResults = verdict.items.slice();
        var byId = {};
        verdict.items.forEach(function (item) { byId[item.clientOrderId] = item; });
        var unknown = [];
        var next = [];
        this.stagedBatchOrders.forEach(function (draft) {
          var item = byId[draft.clientOrderId];
          if (!item) {
            next.push(draft);
            return;
          }
          draft.result = item.result;
          if (item.status === 'accepted') return;
          draft.status = item.status;
          next.push(draft);
          if (item.status === 'unknown') unknown.push(item);
        });
        this.stagedBatchOrders = next;
        this.pendingBatchOutcome = unknown.length ? {
          action: 'batch_submit',
          phase: 'unknown',
          symbol: this.currentCoin.symbol,
          items: unknown.map(function (item) {
            return { clientOrderId: item.clientOrderId, body: item.body, status: 'unknown' };
          })
        } : null;
        if (verdict.kind === 'unknown') {
          this.batchMessage = this.$t('exchange.residual.batchUnknownCopy');
        } else if (verdict.kind === 'refused') {
          this.batchMessage = this.$t('exchange.residual.batchRequestRefused', { reason: verdict.message || '' });
        } else {
          this.batchMessage = this.$t('exchange.residual.batchMixedResult');
        }
        this.persistBatchState();
        this.loadAccount();
      });
    },

    stageCurrentBatchAmend() {
      if (!this.amendOrder) return this.warn(this.$t('exchange.residual.amendNoLongerEligible'));
      if (!this.isNativeAmend) return this.warn(this.$t('exchange.residual.batchAmendNativeOnly'));
      if (this.batchAmendStageDisabled) {
        if (this.stagedBatchAmends.length >= MAX_BATCH_AMENDS) {
          return this.warn(this.$t('exchange.residual.batchCapReached', { max: MAX_BATCH_AMENDS }));
        }
        return;
      }
      var fieldErr = this.validateOrderFields();
      if (fieldErr) {
        this.focusOrderError(fieldErr);
        return this.warn(fieldErr);
      }
      var draft = ixBatchAmend.createDraft({
        orderId: this.amendOrder.orderId,
        qty: String(this.form.amount).trim()
      });
      var check = ixBatchAmend.validateDrafts(this.stagedBatchAmends.concat([draft]));
      if (!check.ok) return this.warn(check.message);
      this.stagedBatchAmends.push(draft);
      this.batchAmendMessage = this.$t('exchange.residual.batchAmendStaged', { id: draft.orderId });
    },

    removeBatchAmendDraft(index) {
      var draft = this.stagedBatchAmends[index];
      if (!draft || draft.status === 'unknown') return;
      this.stagedBatchAmends.splice(index, 1);
    },

    abandonBatchAmendDraft(index) {
      var draft = this.stagedBatchAmends[index];
      if (!draft || draft.status !== 'unknown') return;
      this.$Modal.confirm({
        title: this.$t('exchange.residual.abandonBatchUnknownTitle'),
        content: this.$t('exchange.residual.abandonBatchUnknownCopy', { id: draft.orderId }),
        okText: this.$t('exchange.residual.abandonBatchUnknown'),
        cancelText: this.$t('exchange.terminal.cancel'),
        onOk: () => {
          this.stagedBatchAmends.splice(index, 1);
          if (this.pendingBatchAmendOutcome && Array.isArray(this.pendingBatchAmendOutcome.items)) {
            this.pendingBatchAmendOutcome.items = this.pendingBatchAmendOutcome.items.filter(function (item) {
              return item.orderId !== draft.orderId;
            });
            if (!this.pendingBatchAmendOutcome.items.length) this.pendingBatchAmendOutcome = null;
          }
          this.batchAmendMessage = this.$t('exchange.residual.batchUnknownAbandoned', { id: draft.orderId });
        }
      });
    },

    submitBatchAmends() {
      if (this.submitting || this.pendingOutcome || !this.batchAmendStagedCount) return;
      var drafts = this.stagedBatchAmends.filter(function (draft) { return draft.status === 'staged'; });
      var built = ixBatchAmend.buildPayload(drafts);
      if (!built.ok) return this.warn(built.message);
      this.submitting = true;
      return rest('/orders/batch-amend', { method: 'POST', token: this.ixToken, body: built.payload }).then(res => {
        this.submitting = false;
        var verdict = ixBatchAmend.classifyResponse(res, drafts);
        if (!verdict || !verdict.items) {
          this.batchAmendMessage = (verdict && verdict.message) || this.$t('exchange.residual.batchAmendUnknownCopy');
          return;
        }
        this.batchAmendResults = verdict.items.slice();
        var byId = {};
        verdict.items.forEach(function (item) { byId[item.orderId] = item; });
        var unknown = [];
        var next = [];
        this.stagedBatchAmends.forEach(function (draft) {
          var item = byId[draft.orderId];
          if (!item) {
            next.push(draft);
            return;
          }
          draft.result = item.result;
          if (item.status === 'applied') return;
          draft.status = item.status;
          next.push(draft);
          if (item.status === 'unknown') unknown.push(item);
        });
        this.stagedBatchAmends = next;
        this.pendingBatchAmendOutcome = unknown.length ? {
          action: 'batch_amend',
          phase: 'unknown',
          items: unknown.map(function (item) {
            return { orderId: item.orderId, qty: item.qty, status: 'unknown' };
          })
        } : null;
        if (verdict.kind === 'unknown') {
          this.batchAmendMessage = this.$t('exchange.residual.batchAmendUnknownCopy');
        } else if (verdict.kind === 'refused') {
          this.batchAmendMessage = this.$t('exchange.residual.batchAmendRequestRefused', { reason: verdict.message || '' });
        } else {
          this.batchAmendMessage = this.$t('exchange.residual.batchAmendMixedResult');
        }
        this.loadAccount();
      });
    },

    persistPendingOutcome() {
      this.releaseDupTabSubmitLock();
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      try {
        if (this.pendingOutcome) {
          window.sessionStorage.setItem(this.pendingOutcomeStorageKey(this.pendingOutcome), JSON.stringify(this.pendingOutcome));
        } else {
          window.sessionStorage.removeItem(this.pendingOutcomeStorageKey());
          window.sessionStorage.removeItem(this.pendingOutcomeStorageKey({ action: 'cancel_all', scope: 'all' }));
        }
      } catch (e) {
        /* Storage is a convenience for reload recovery, never a write gate. */
      }
    },

    restorePendingOutcome() {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      try {
        var scopedRaw = window.sessionStorage.getItem(this.pendingOutcomeStorageKey());
        var allRaw = window.sessionStorage.getItem(this.pendingOutcomeStorageKey({ action: 'cancel_all', scope: 'all' }));
        var raw = allRaw || scopedRaw;
        var saved = raw ? JSON.parse(raw) : null;
        if (!saved || typeof saved !== 'object' || !saved.action ||
          (saved.action !== 'cancel_all' && !saved.clientOrderId)) return;
        this.pendingOutcome = saved;
        this.pendingClientOrderId = saved.clientOrderId;
        var held = this._dupTabLock && this._dupTabLock.read();
        if (held && saved.clientOrderId && held.clientOrderId === saved.clientOrderId) {
          this._dupTabLockOwned = true;
        }
      } catch (e) {
        this.pendingOutcome = null;
      }
    },

    clearOrderSubmissionIdentity() {
      this.clearPendingOrderIdentity();
      this.clearPendingAdvancedIdentity();
    },

    clearPendingScaleIdentity() {
      this.pendingScaleOrders = [];
      this.batchAcceptedChildren = 0;
      this.orderValidationError = '';
    },

    clearPendingBracketIdentity() {
      this.pendingBracketOrders = [];
      this.bracketAcceptedCount = 0;
      this.pendingBracketPositionId = '';
      this.orderValidationError = '';
    },

    clearPendingAdvancedIdentity() {
      this.clearPendingScaleIdentity();
      this.clearPendingBracketIdentity();
    },

    onScaleEndPriceInput() {
      this.scaleEndPrice = this.clamp(this.scaleEndPrice, this.baseCoinScale);
      this.clearPendingScaleIdentity();
    },

    onAttachedTriggerInput(kind) {
      if (kind === 'take') {
        this.attachedTakeProfit = this.clamp(this.attachedTakeProfit, this.baseCoinScale);
      } else {
        this.attachedStopLoss = this.clamp(this.attachedStopLoss, this.baseCoinScale);
      }
      this.clearPendingBracketIdentity();
    },

    /**
     * Inline validation — prefer a named reason over a silent disabled button.
     * Never invent fees or balances; wallet unknown stays "unknown", not zero.
     */
    validateOrderFields() {
      const amountRaw = String(this.form.amount || '').trim();
      const priceRaw = String(this.form.price || '').trim();
      if (!amountRaw) return 'Enter an amount.';
      if (/[eE]/.test(amountRaw) || /[eE]/.test(priceRaw)) {
        return 'Scientific notation is not accepted — use a plain decimal.';
      }
      if (!ixMoney.isPositive(amountRaw)) return 'Enter a valid amount greater than zero.';
      if (ixMoney.greaterThan(amountRaw, '1000000000000')) return 'Amount is too large.';
      if (this.orderNeedsLimitPrice) {
        if (!priceRaw) return 'Enter a limit price.';
        if (!ixMoney.isPositive(priceRaw)) return 'Enter a valid limit price greater than zero.';
        if (ixMoney.greaterThan(priceRaw, '1000000000000')) return 'Price is too large.';
      }
      if (this.orderNeedsStopPrice) {
        var stopRaw = String(this.form.stopPrice || '').trim();
        if (!stopRaw || !ixMoney.isPositive(stopRaw)) return 'Enter a valid trigger price greater than zero.';
      }
      if (this.orderType === 'trailing_stop') {
        var trailRaw = String(this.form.trail || '').trim();
        if (!trailRaw || !ixMoney.isPositive(trailRaw)) {
          return 'a trailing stop requires a trail; trade does not invent a distance';
        }
        var markRaw = String(this.form.mark || '').trim();
        if (!markRaw || !ixMoney.isPositive(markRaw)) {
          return 'a trailing stop walks with the mark; trade does not invent a mark';
        }
      }
      if (this.postOnly && this.timeInForce !== 'GTC' && this.timeInForce !== 'PO') {
        return 'Post-only cannot be combined with IOC or FOK.';
      }
      /* Cost for the insufficient-balance check only — not a wire amount. */
      var costStr = this.quoteSized
        ? amountRaw
        : this.side === 'BUY'
          ? ixMoney.multiply(priceRaw, amountRaw)
          : amountRaw;
      if (
        this.isLogin &&
        this.walletReachable &&
        costStr !== null &&
        ixMoney.isPositive(this.availableBalance) &&
        ixMoney.greaterThan(costStr, this.availableBalance)
      ) {
        return 'Insufficient balance. Available ' + this.availableBalance + '.';
      }
      return '';
    },

    /**
     * A-UI-A11Y / B10 — GOV.UK: move keyboard focus to error summary;
     * LiveAnnouncer-style clear-then-set when the same message re-fires.
     */
    focusOrderError(msg) {
      var next = msg || this.orderValidationError || '';
      this.orderValidationError = next;
      var plan = deskA11y.liveAnnounceUpdate(this.liveAnnounce, next);
      var self = this;
      var afterAnnounce = function () {
        self.$nextTick(function () {
          self.focusErrorSummary();
        });
      };
      if (plan.needsClearFirst) {
        this.liveAnnounce = '';
        this.$nextTick(function () {
          self.liveAnnounce = plan.text;
          afterAnnounce();
        });
      } else {
        this.liveAnnounce = plan.text;
        afterAnnounce();
      }
    },

    /** Focus the GOV.UK error summary (not a field) so AT and keyboard land first. */
    focusErrorSummary() {
      var el = this.$refs.orderErrorSummary;
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
    },

    /** Error-summary link → associated field (amount or price). */
    focusTicketErrorField() {
      var summary = this.orderErrorSummary;
      if (!summary || !summary.fieldId) {
        return this.focusErrorSummary();
      }
      var el =
        summary.field === 'price'
          ? this.$refs.ticketPrice
          : summary.field === 'amount'
            ? this.$refs.ticketAmount
            : null;
      if (el && !el.disabled && typeof el.focus === 'function') {
        el.focus();
        if (typeof el.select === 'function') el.select();
        return;
      }
      this.focusErrorSummary();
    },

    submitOrder() {
      if (this.dupTabLockHeld && this.dupTabLockHeld.clientOrderId) {
        var locked = this.deskLock;
        var lockedMsg = (locked && locked.message) || 'Order is already being submitted.';
        this.focusOrderError(lockedMsg);
        return this.warn(lockedMsg);
      }
      const opensPerp = this.isPerpKind && this.orderType !== 'tpsl' && !this.reduceOnly;
      if (opensPerp && !this.adlDisclosure.acknowledged) {
        return this.requireAdlDisclosureAck();
      }
      return this.submitOrderAfterAdl();
    },

    /**
     * GET the server-versioned disclosure before the first opening perp order.
     * A failed/malformed GET, cancelled modal, or failed ack is terminal for
     * this submit attempt: no order method is reached.
     */
    requireAdlDisclosureAck() {
      if (this.adlDisclosureLoading) return;
      if (!this.ixToken) {
        const sessionMsg = this.$t('intafaced.trade.noSession');
        this.focusOrderError(sessionMsg);
        return this.warn(sessionMsg);
      }
      this.adlDisclosureLoading = true;
      return rest('/futures/adl-disclosure', { token: this.ixToken }).then(res => {
        this.adlDisclosureLoading = false;
        const row = res && res.ok ? res.data : null;
        const valid = row && typeof row === 'object' &&
          typeof row.version === 'string' && row.version.length > 0 &&
          typeof row.copy === 'string' && row.copy.length > 0 &&
          typeof row.acknowledged === 'boolean' &&
          (row.acknowledgedAt === null || typeof row.acknowledgedAt === 'string');
        if (!valid) {
          const message = (res && res.message) || 'ADL disclosure is unavailable; no perp order was placed.';
          this.focusOrderError(message);
          return this.warn(message);
        }
        this.adlDisclosure = {
          version: row.version,
          copy: row.copy,
          acknowledged: row.acknowledged,
          acknowledgedAt: row.acknowledgedAt
        };
        if (row.acknowledged) return this.submitOrderAfterAdl();

        const self = this;
        this.$Modal.confirm({
          title: this.$t('exchange.hlplus.perps'),
          content: '<p>' + this.escapeDisclosureCopy(row.copy) + '</p><p><strong>Version ' + this.escapeDisclosureCopy(row.version) + '</strong></p>',
          okText: this.$t('exchange.terminal.confirm'),
          cancelText: this.$t('exchange.terminal.cancel'),
          onOk: function() {
            self.adlDisclosureLoading = true;
            return rest('/futures/adl-disclosure/ack', {
              method: 'POST',
              token: self.ixToken,
              body: {}
            }).then(function(ackRes) {
              self.adlDisclosureLoading = false;
              const ack = ackRes && ackRes.ok ? ackRes.data : null;
              const accepted = ack && typeof ack === 'object' && ack.acknowledged === true &&
                ack.version === row.version && typeof ack.copy === 'string';
              if (!accepted) {
                const message = (ackRes && ackRes.message) || 'ADL acknowledgement was not accepted; no perp order was placed.';
                self.focusOrderError(message);
                self.warn(message);
                return;
              }
              self.adlDisclosure = {
                version: ack.version,
                copy: ack.copy,
                acknowledged: true,
                acknowledgedAt: typeof ack.acknowledgedAt === 'string' ? ack.acknowledgedAt : null
              };
              return self.submitOrderAfterAdl();
            });
          }
        });
      });
    },

    escapeDisclosureCopy(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    submitOrderAfterAdl() {
      if (this.amendOrder) return this.submitAmend();
      if (this.orderType === 'twap') return this.submitTwap();
      if (this.orderType === 'scale') return this.submitScale();
      if (this.orderType === 'tpsl') return this.submitAttachedTpsl();
      if (!this.tradable || this.submitting) {
        return;
      }
      if (this.orderBlockReason) {
        this.focusOrderError(this.orderBlockReason);
        return this.warn(this.orderBlockReason);
      }
      const fieldErr = this.validateOrderFields();
      if (fieldErr) {
        this.focusOrderError(fieldErr);
        return this.warn(fieldErr);
      }
      this.orderValidationError = '';
      this.liveAnnounce = '';

      /* Confirm copy must match the wire: form strings, not float→fmt. */
      const amountText = String(this.form.amount == null ? '' : this.form.amount).trim() || '—';
      const priceText = String(this.form.price == null ? '' : this.form.price).trim() || '—';

      const side = this.side === 'BUY' ? this.$t('exchange.terminal.buy') : this.$t('exchange.terminal.sell');
      const type = this.orderTypeLabel({ type: this.wireOrderType.toUpperCase() });
      const priceLine =
        !this.orderNeedsLimitPrice
          ? this.$t('exchange.terminal.confirmPriceBest')
          : this.$t('exchange.terminal.confirmPriceLine', { price: priceText + ' ' + (this.currentCoin.base || '') });
      const amountLine =
        this.amountLabel +
        ': ' +
        amountText +
        ' ' +
        (this.amountUnit || '');
      const feeLine = this.spotOrderPreviewRequired
        ? this.$t('exchange.residual.spotPreviewFee') + ': ' +
          this.positionPreviewValue(this.spotOrderPreview && this.spotOrderPreview.estimatedFee) +
          (this.spotOrderPreview && this.spotOrderPreview.feeAsset ? ' ' + this.spotOrderPreview.feeAsset : '')
        : this.$t('exchange.terminal.feeEst') + ': ' + this.feeLabel;
      const holdLine = this.spotOrderPreviewRequired
        ? this.$t('exchange.residual.spotPreviewHold') + ': ' +
          this.positionPreviewValue(this.spotOrderPreview && this.spotOrderPreview.holdAmount) +
          (this.spotOrderPreview && this.spotOrderPreview.holdAsset ? ' ' + this.spotOrderPreview.holdAsset : '')
        : '';
      /* Three states, again — an "Available: 0" on a confirmation dialog for a
         balance we could not read is the last place a fabricated number should
         appear, because it is the screen someone reads before committing. */
      const walletLine = !this.walletReachable
        ? this.$t('exchange.residual.availableUnknown')
        : this.availableBalance === null
          ? this.$t('exchange.residual.availableNoRow', { unit: this.side === 'BUY' ? this.currentCoin.base : this.currentCoin.coin })
          : this.$t('exchange.residual.availableLedger') + ': ' + this.availableBalance;
      const pair = (this.currentCoin.coin || '') + '/' + (this.currentCoin.base || '');

      if (!this.pendingClientOrderId) this.pendingClientOrderId = this.nextClientOrderId();
      if (!this.acquireDupTabSubmitLock(this.pendingClientOrderId)) {
        var heldMsg = (this.deskLock && this.deskLock.message) || 'Order is already being submitted.';
        this.focusOrderError(heldMsg);
        return this.warn(heldMsg);
      }

      this.$Modal.confirm({
        title: this.$t('exchange.terminal.confirmTitle', { side: side.toLowerCase() }),
        // i18n-exempt HTML shell; all user copy via $t / dynamic fee/price lines above
        content:
          '<p><strong>' +
          side +
          ' · ' +
          type +
          '</strong> · ' +
          pair +
          '</p><p>' +
          priceLine +
          '</p><p>' +
          amountLine +
          '</p><p>' +
          feeLine +
          '</p>' +
          (holdLine ? '<p>' + holdLine + '</p>' : '') +
          '<p>' +
          walletLine +
          '</p><p style="margin-top:8px;opacity:0.75;">' + this.$t('exchange.residual.confirmDisclaimerVenue') + '</p>',
        okText: side,
        cancelText: this.$t('exchange.terminal.cancel'),
        /* No arguments: placeOrder reads the decimal STRINGS out of the form.
           `amount` and `price` above are floats parsed for this dialog's copy
           and must not reach the wire. */
        onOk: () => this.placeOrder(),
        onCancel: () => this.releaseDupTabSubmitLock()
      });
    },

    clearPendingAlgoIdentity() {
      this.pendingClientAlgoId = '';
      this.twapParent = null;
      this.orderValidationError = '';
    },

    submitTwap() {
      if (!this.tradable || this.submitting) return;
      if (this.orderBlockReason) {
        this.focusOrderError(this.orderBlockReason);
        return this.warn(this.orderBlockReason);
      }
      const amount = String(this.form.amount || '').trim();
      const duration = String(this.twapDurationSeconds || '').trim();
      let error = '';
      if (!amount || !ixMoney.isPositive(amount)) error = this.$t('exchange.hlplus.twapAmountRequired');
      else if (!/^\d+$/.test(duration) || Number(duration) < 30 || Number(duration) > 86400) {
        error = this.$t('exchange.hlplus.twapDurationInvalid');
      }
      if (error) {
        this.focusOrderError(error);
        return this.warn(error);
      }
      const durationMs = Number(duration) * 1000;
      const self = this;
      this.$Modal.confirm({
        title: this.$t('exchange.hlplus.twapConfirmTitle'),
        content: this.$t('exchange.hlplus.twapConfirm', { amount: amount, duration: duration }),
        onOk: function() {
          return self.placeTwap(durationMs);
        }
      });
    },

    placeTwap(durationMs) {
      if (!this.ixToken) return;
      this.submitting = true;
      if (!this.pendingClientAlgoId) {
        this.pendingClientAlgoId = ('desk-twap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)).slice(0, 48);
      }
      const input = {
        symbol: this.currentCoin.symbol,
        side: this.side === 'BUY' ? 'buy' : 'sell',
        totalQty: String(this.form.amount).trim(),
        durationMs: durationMs,
        sliceIntervalMs: 30000,
        clientAlgoId: this.pendingClientAlgoId
      };
      return mutate('trade', 'algo.createTwap', input, this.ixToken).then(res => {
        this.submitting = false;
        const row = res && res.ok && res.data;
        if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') {
          this.focusOrderError((res && (res.message || res.code)) || this.$t('exchange.hlplus.twapUnavailable'));
          return;
        }
        this.twapParent = row;
        this.pendingClientAlgoId = '';
        this.form.amount = '';
        this.orderValidationError = '';
        this.liveAnnounce = this.$t('exchange.hlplus.twapCreated');
        this.$Notice.success({ title: this.$t('exchange.hlplus.twapCreated'), desc: row.id });
      });
    },

    submitScale() {
      if (!this.tradable || this.submitting) return;
      if (this.orderBlockReason) {
        this.focusOrderError(this.orderBlockReason);
        return this.warn(this.orderBlockReason);
      }
      const commonError = this.validateOrderFields();
      const end = String(this.scaleEndPrice || '').trim();
      const countText = String(this.scaleOrderCount || '').trim();
      let error = commonError;
      if (!error && (!ixMoney.isPositive(end) || ixMoney.compare(end, this.form.price) === 0)) {
        error = this.$t('exchange.hlplus.scaleEndInvalid');
      }
      if (!error && (!/^\d+$/.test(countText) || Number(countText) < 2 || Number(countText) > 64)) {
        error = this.$t('exchange.hlplus.scaleCountInvalid');
      }
      if (error) {
        this.focusOrderError(error);
        return this.warn(error);
      }
      if (!this.pendingScaleOrders.length) {
        const built = this.buildScaleOrders(Number(countText));
        if (!built.ok) {
          this.focusOrderError(built.message);
          return this.warn(built.message);
        }
        this.pendingScaleOrders = built.orders;
        this.batchAcceptedChildren = 0;
      }
      const self = this;
      this.$Modal.confirm({
        title: this.$t('exchange.hlplus.scaleConfirmTitle'),
        content: this.$t('exchange.hlplus.scaleConfirm', {
          count: this.pendingScaleOrders.length,
          start: String(this.form.price).trim(),
          end: end
        }),
        onOk: function() {
          return self.placeScale();
        }
      });
    },

    buildScaleOrders(count) {
      const start = String(this.form.price).trim();
      const end = String(this.scaleEndPrice).trim();
      const total = String(this.form.amount).trim();
      const step = ixMoney.divide(ixMoney.subtract(end, start), String(count - 1), this.baseCoinScale);
      const slice = ixMoney.divide(total, String(count), this.coinScale);
      if (step === null || ixMoney.compare(step, '0') === 0) {
        return { ok: false, message: this.$t('exchange.hlplus.scaleStepTooSmall') };
      }
      if (!ixMoney.isPositive(slice)) {
        return { ok: false, message: this.$t('exchange.hlplus.scaleAmountTooSmall') };
      }
      const orders = [];
      let remaining = total;
      for (let index = 0; index < count; index += 1) {
        const price = index === count - 1
          ? end
          : ixMoney.add(start, ixMoney.multiply(step, String(index), this.baseCoinScale));
        const amount = index === count - 1 ? remaining : slice;
        if (!ixMoney.isPositive(price) || !ixMoney.isPositive(amount)) {
          return { ok: false, message: this.$t('exchange.hlplus.scaleAmountTooSmall') };
        }
        orders.push(ixTrade.toCreateOrderBody({
          symbol: this.currentCoin.symbol,
          type: 'LIMIT_PRICE',
          side: this.side,
          amount: amount,
          price: price,
          timeInForce: this.timeInForce,
          postOnly: this.postOnly || this.timeInForce === 'PO',
          reduceOnly: this.reduceOnly,
          clientOrderId: this.nextClientOrderId()
        }));
        remaining = ixMoney.subtract(remaining, amount);
      }
      return { ok: true, orders: orders };
    },

    placeScale() {
      if (!this.ixToken || !this.pendingScaleOrders.length) return;
      this.submitting = true;
      const sendNext = () => {
        if (this.batchAcceptedChildren >= this.pendingScaleOrders.length) {
          const count = this.pendingScaleOrders.length;
          this.submitting = false;
          this.pendingScaleOrders = [];
          this.batchAcceptedChildren = 0;
          this.form.amount = '';
          this.scaleEndPrice = '';
          this.scaleOrderCount = '';
          this.percent = 0;
          this.accountTab = 'open';
          this.orderValidationError = '';
          this.liveAnnounce = this.$t('exchange.hlplus.scaleCreated', { count: count });
          this.$Notice.success({ title: this.liveAnnounce });
          this.loadAccount();
          return;
        }
        const body = this.pendingScaleOrders[this.batchAcceptedChildren];
        return rest('/orders', { method: 'POST', token: this.ixToken, body: body }).then(res => {
          const verdict = ixOrderOutcome.classify(res, 'submit');
          if (verdict.kind === 'unknown') {
            this.submitting = false;
            this.recordUnknownOutcome('submit', verdict, {
              clientOrderId: body.clientOrderId,
              symbol: body.symbol
            });
            return;
          }
          if (verdict.kind !== 'applied') {
            this.submitting = false;
            const reason = ixTrade.orderFailureMessage(res, 'create');
            const message = this.$t('exchange.hlplus.scalePartial', {
              accepted: this.batchAcceptedChildren,
              total: this.pendingScaleOrders.length,
              reason: reason
            });
            this.focusOrderError(message);
            this.$Notice.error({ title: this.$t('intafaced.trade.rejected'), desc: message });
            return;
          }
          this.batchAcceptedChildren += 1;
          return sendNext();
        });
      };
      return sendNext();
    },

    submitAttachedTpsl() {
      if (!this.tradable || this.submitting) return;
      if (this.orderBlockReason) {
        this.focusOrderError(this.orderBlockReason);
        return this.warn(this.orderBlockReason);
      }
      const symbol = this.currentCoin && this.currentCoin.symbol;
      const matchingPositions = this.positions.filter(row => row.symbol === symbol && row.status === 'open');
      const amount = String(this.form.amount || '').trim();
      const take = String(this.attachedTakeProfit || '').trim();
      const stop = String(this.attachedStopLoss || '').trim();
      let error = '';
      if (!this.isPerpKind) error = this.$t('exchange.hlplus.tpslPerpsOnly');
      else if (!this.positionsReachable) error = this.$t('exchange.hlplus.tpslPositionsUnavailable');
      else if (matchingPositions.length === 0) error = this.$t('exchange.hlplus.tpslPositionRequired');
      else if (matchingPositions.length > 1) error = this.$t('exchange.hlplus.tpslPositionAmbiguous');
      else if (!ixMoney.isPositive(amount) || ixMoney.greaterThan(amount, matchingPositions[0].contracts)) {
        error = this.$t('exchange.hlplus.tpslAmountInvalid');
      } else if (!ixMoney.isPositive(take) || !ixMoney.isPositive(stop)) {
        error = this.$t('exchange.hlplus.tpslTriggersRequired');
      } else {
        const entry = matchingPositions[0].entryPrice;
        const takeVsEntry = ixMoney.compare(take, entry);
        const stopVsEntry = ixMoney.compare(stop, entry);
        const validDirection = matchingPositions[0].side === 'long'
          ? takeVsEntry > 0 && stopVsEntry < 0
          : takeVsEntry < 0 && stopVsEntry > 0;
        if (!validDirection) error = this.$t('exchange.hlplus.tpslTriggerDirection');
      }
      if (error) {
        this.focusOrderError(error);
        return this.warn(error);
      }
      const position = matchingPositions[0];
      if (this.pendingBracketOrders.length && this.pendingBracketPositionId !== position.id) {
        this.clearPendingBracketIdentity();
      }
      if (!this.pendingBracketOrders.length) {
        const closeSide = position.side === 'long' ? 'SELL' : 'BUY';
        this.pendingBracketOrders = [
          ixTrade.toCreateOrderBody({
            symbol: symbol,
            type: 'take_profit',
            side: closeSide,
            amount: amount,
            stopPrice: take,
            timeInForce: 'GTC',
            reduceOnly: true,
            clientOrderId: this.nextClientOrderId()
          }),
          ixTrade.toCreateOrderBody({
            symbol: symbol,
            type: 'stop',
            side: closeSide,
            amount: amount,
            stopPrice: stop,
            timeInForce: 'GTC',
            reduceOnly: true,
            clientOrderId: this.nextClientOrderId()
          })
        ];
        this.bracketAcceptedCount = 0;
        this.pendingBracketPositionId = position.id;
      }
      const self = this;
      this.$Modal.confirm({
        title: this.$t('exchange.hlplus.tpslConfirmTitle'),
        content: this.$t('exchange.hlplus.tpslConfirm', { amount: amount, take: take, stop: stop }),
        onOk: function() {
          return self.placeAttachedTpsl();
        }
      });
    },

    placeAttachedTpsl() {
      if (!this.ixToken || !this.pendingBracketOrders.length) return;
      this.submitting = true;
      const sendNext = () => {
        if (this.bracketAcceptedCount >= this.pendingBracketOrders.length) {
          this.submitting = false;
          this.pendingBracketOrders = [];
          this.bracketAcceptedCount = 0;
          this.pendingBracketPositionId = '';
          this.form.amount = '';
          this.attachedTakeProfit = '';
          this.attachedStopLoss = '';
          this.percent = 0;
          this.accountTab = 'open';
          this.orderValidationError = '';
          this.liveAnnounce = this.$t('exchange.hlplus.tpslCreated');
          this.$Notice.success({ title: this.liveAnnounce });
          this.loadAccount();
          return;
        }
        const body = this.pendingBracketOrders[this.bracketAcceptedCount];
        return rest('/orders', { method: 'POST', token: this.ixToken, body: body }).then(res => {
          const verdict = ixOrderOutcome.classify(res, 'submit');
          if (verdict.kind === 'unknown') {
            this.submitting = false;
            this.recordUnknownOutcome('submit', verdict, {
              clientOrderId: body.clientOrderId,
              symbol: body.symbol
            });
            return;
          }
          if (verdict.kind !== 'applied') {
            this.submitting = false;
            const reason = ixTrade.orderFailureMessage(res, 'create');
            const message = this.$t('exchange.hlplus.tpslPartial', {
              accepted: this.bracketAcceptedCount,
              reason: reason
            });
            this.focusOrderError(message);
            this.$Notice.error({ title: this.$t('intafaced.trade.rejected'), desc: message });
            return;
          }
          this.bracketAcceptedCount += 1;
          return sendNext();
        });
      };
      return sendNext();
    },

    /**
     * PLACE AN ORDER — `POST /api/v1/orders`. The money path.
     *
     * AMOUNT AND PRICE GO OUT AS THE STRINGS THE USER TYPED. `submitOrder`
     * hands this method parsed numbers for the confirmation copy; they are NOT
     * what is sent. `this.form.amount` and `this.form.price` are the decimal
     * strings from the input, the contract's schema takes decimal strings, and
     * the ledger parses them to a scaled bigint. Routing an order size through
     * a JS float would round it at the seventeenth significant digit — silently,
     * and on exactly the values where it matters.
     *
     * A market order carries no price key at all. The schema rejects a price on
     * a market order, and the old `price: 0` was in any case a price we made up.
     */
    /**
     * Close a futures position via DELETE /api/v1/positions/:id.
     * ACCEPTED / REJECTED / UNKNOWN — not a fill promise. Codex mounts chrome.
     */
    closePosition(positionId) {
      if (!this.ixToken) {
        const sessionMsg = this.$t('intafaced.trade.noSession');
        this.focusOrderError(sessionMsg);
        return this.warn(sessionMsg);
      }
      if (this.orderBlockReason) {
        this.focusOrderError(this.orderBlockReason);
        return this.warn(this.orderBlockReason);
      }
      if (!positionId) {
        const missing = this.$t('exchange.residual.openOrdersUnknown');
        this.focusOrderError(missing);
        return this.warn(missing);
      }
      return rest('/positions/' + encodeURIComponent(positionId), {
        method: 'DELETE',
        token: this.ixToken
      }).then((res) => {
        const verdict = ixOrderOutcome.classify(res, 'close');
        if (verdict.kind === 'unknown') {
          this.recordUnknownOutcome('close', verdict, { orderId: String(positionId) });
          return verdict;
        }
        if (verdict.kind === 'applied') {
          this.loadAccount();
          return verdict;
        }
        const refused = verdict.message || this.$t('exchange.residual.openOrdersUnknown');
        this.focusOrderError(refused);
        this.warn(refused);
        return verdict;
      });
    },

    placeOrder() {
      if (!this.ixToken) {
        this.releaseDupTabSubmitLock();
        const sessionMsg = this.$t('intafaced.trade.noSession');
        this.focusOrderError(sessionMsg);
        return this.warn(sessionMsg);
      }
      var subBlock = subAccounts.tradeBlockReason(this.$store.state.ixSubAccountId);
      if (subBlock) {
        this.releaseDupTabSubmitLock();
        this.focusOrderError(subBlock);
        return this.warn(subBlock);
      }
      if (this.spotOrderPreviewRequired && (!this.spotOrderPreview || this.spotOrderPreview.orderable !== true)) {
        this.releaseDupTabSubmitLock();
        const previewMsg = this.orderBlockReason || this.$t('exchange.residual.spotPreviewUnavailable');
        this.focusOrderError(previewMsg);
        return this.warn(previewMsg);
      }
      if (!this.pendingClientOrderId) this.pendingClientOrderId = this.nextClientOrderId();
      if (!this.acquireDupTabSubmitLock(this.pendingClientOrderId)) {
        const heldPlace = (this.deskLock && this.deskLock.message) || 'Order is already being submitted.';
        this.focusOrderError(heldPlace);
        return this.warn(heldPlace);
      }
      this.submitting = true;
      const placeInput = {
        symbol: this.currentCoin.symbol,
        type: this.orderType,
        side: this.side,
        amount: String(this.form.amount).trim(),
        price: String(this.form.price).trim(),
        stopPrice: String(this.form.stopPrice).trim(),
        timeInForce: this.timeInForce,
        postOnly: this.postOnly || this.timeInForce === 'PO',
        reduceOnly: this.reduceOnly,
        clientOrderId: this.pendingClientOrderId
      };
      if (this.orderType === 'trailing_stop') {
        placeInput.trail = String(this.form.trail || '').trim();
        placeInput.mark = String(this.form.mark || '').trim();
      }
      const body = ixTrade.toCreateOrderBody(placeInput);
      return rest('/orders', { method: 'POST', token: this.ixToken, body: body }).then(res => {
        this.submitting = false;
        const verdict = ixOrderOutcome.classify(res, 'submit');
        if (verdict.kind === 'unknown') {
          this.recordUnknownOutcome('submit', verdict, {
            clientOrderId: this.pendingClientOrderId,
            symbol: this.currentCoin.symbol
          });
          return;
        }
        if (verdict.kind === 'applied') {
          this.releaseDupTabSubmitLock();
          this.orderValidationError = '';
          this.liveAnnounce = '';
          this.$Notice.success({ title: this.$t('intafaced.trade.placed'), desc: this.submitLabel });
          this.form.amount = '';
          this.form.stopPrice = '';
          this.form.trail = '';
          this.form.mark = '';
          this.pendingClientOrderId = '';
          this.percent = 0;
          this.accountTab = 'open';
          this.loadAccount();
          return;
        }
        /* Reject copy goes in the ticket, not only a toast, so the form never
           looks like it succeeded. Every message ends by saying no order was
           placed — an ambiguous failure gets an order placed twice. */
        this.releaseDupTabSubmitLock();
        const rejectMsg = ixTrade.orderFailureMessage(res, 'create');
        this.focusOrderError(rejectMsg);
        this.$Notice.error({ title: this.$t('intafaced.trade.rejected'), desc: rejectMsg });
      }).catch(() => {
        this.submitting = false;
        this.recordUnknownOutcome('submit', { kind: 'unknown' }, {
          clientOrderId: this.pendingClientOrderId,
          symbol: this.currentCoin.symbol
        });
      });
    },

    /** Only untouched open spot orders can enter the bounded amend ticket. */
    canAmendOrder(order) {
      if (!order || this.isPerpKind || order.status !== 'TRADING') return false;
      var type = String(order.type || '').toUpperCase();
      if (type !== 'LIMIT_PRICE' && type !== 'MARKET_PRICE') return false;
      if (order.recoveryRequired === true || order.executionOutcome) return false;
      return !order.tradedAmount || !ixMoney.isPositive(String(order.tradedAmount));
    },

    nextAmendClientOrderId() {
      var suffix = Math.random().toString(36).slice(2, 10);
      return ('amend-' + Date.now().toString(36) + '-' + suffix).slice(0, 56);
    },

    beginAmend(order) {
      if (!this.canAmendOrder(order) || this.pendingOutcome || this.submitting) return;
      this.amendOrder = order;
      this.side = order.direction === 'SELL' ? 'SELL' : 'BUY';
      this.orderType = order.type === 'MARKET_PRICE' ? 'MARKET_PRICE' : 'LIMIT_PRICE';
      this.timeInForce = order.tif || 'GTC';
      this.postOnly = order.postOnly === true || this.timeInForce === 'PO';
      this.reduceOnly = false;
      this.form.amount = String(order.amount == null ? '' : order.amount);
      this.form.price = order.price == null ? '' : String(order.price);
      this.form.stopPrice = '';
      this.percent = 0;
      this.pendingClientOrderId = this.nextAmendClientOrderId();
      this.orderValidationError = '';
      this.accountTab = 'open';
      this.$nextTick(() => this.focusTicket());
    },

    cancelAmend() {
      if (this.submitting) return;
      this.amendOrder = null;
      this.pendingClientOrderId = '';
      this.form.amount = '';
      this.form.price = '';
      this.form.stopPrice = '';
      this.orderValidationError = '';
    },

    submitAmend() {
      if (!this.amendOrder || !this.ixToken || this.submitting || this.pendingOutcome) return;
      if (!this.canAmendOrder(this.amendOrder)) {
        var eligibility = this.$t('exchange.residual.amendNoLongerEligible');
        this.focusOrderError(eligibility);
        return this.warn(eligibility);
      }
      var fieldErr = this.validateOrderFields();
      if (fieldErr) {
        this.focusOrderError(fieldErr);
        return this.warn(fieldErr);
      }
      if (!this.pendingClientOrderId) this.pendingClientOrderId = this.nextAmendClientOrderId();
      var original = this.amendOrder;
      var ticket = this.amendTicket;
      var route = ixTrade.amendRoute(original, ticket);
      var self = this;
      var confirmTitle = route === 'NATIVE_AMEND'
        ? this.$t('exchange.residual.amendNativeConfirmTitle')
        : this.$t('exchange.residual.amendConfirmTitle');
      var confirmCopy = route === 'NATIVE_AMEND'
        ? this.$t('exchange.residual.amendNativeCopy')
        : this.$t('exchange.residual.amendSagaCopy');
      var confirmId = route === 'NATIVE_AMEND'
        ? this.$t('exchange.residual.amendNativeOrderId', { id: original.orderId })
        : this.$t('exchange.residual.amendClientOrderId', { id: this.pendingClientOrderId });
      this.$Modal.confirm({
        title: confirmTitle,
        content: '<p>' + confirmCopy + '</p><p>' + confirmId + '</p>',
        okText: this.$t('exchange.residual.amend'),
        cancelText: this.$t('exchange.terminal.cancel'),
        onOk: function () {
          if (route === 'NATIVE_AMEND') return self.submitNativeAmend(original, ticket);
          return self.submitReplaceAmend(original, ticket);
        }
      });
    },

    submitNativeAmend(original, ticket) {
      var self = this;
      self.submitting = true;
      return rest('/orders/' + encodeURIComponent(original.orderId), {
        method: 'PATCH',
        token: self.ixToken,
        body: ixTrade.toAmendOrderBody(ticket)
      }).then(function (res) {
        self.submitting = false;
        var verdict = ixOrderOutcome.classifyAmend(res);
        if (verdict.kind === 'unknown') {
          self.recordUnknownOutcome('amend', verdict, {
            orderId: original.orderId,
            clientOrderId: original.clientOrderId || self.pendingClientOrderId,
            symbol: original.symbol,
            reconcileTarget: 'original',
            path: 'NATIVE_AMEND'
          });
          self.loadAccount();
          return;
        }
        if (verdict.kind === 'applied') {
          self.amendOrder = null;
          self.pendingClientOrderId = '';
          self.form.amount = '';
          self.form.price = '';
          self.form.stopPrice = '';
          self.orderValidationError = '';
          var successKey = 'exchange.residual.amendSuccessUnreported';
          if (verdict.priority === 'retained') successKey = 'exchange.residual.amendSuccessRetained';
          else if (verdict.priority === 'lost') successKey = 'exchange.residual.amendSuccessLost';
          self.liveAnnounce = self.$t(successKey);
          self.$Notice.success({ title: self.liveAnnounce, desc: original.symbol });
          self.accountTab = 'open';
          self.loadAccount();
          return;
        }
        var reason = verdict.reasonCode || (res && res.data && res.data.code) || 'AMEND_REFUSED';
        var message = self.$t('exchange.residual.amendRefused', { reason: reason });
        self.amendOrder = null;
        self.pendingClientOrderId = '';
        self.focusOrderError(message);
        self.$Notice.error({ title: self.$t('exchange.residual.amend'), desc: message });
        self.loadAccount();
      });
    },

    submitReplaceAmend(original, ticket) {
      var self = this;
      var body = ixTrade.toReplaceOrderBody({
        symbol: ticket.symbol,
        type: ticket.type,
        side: ticket.side,
        amount: ticket.amount,
        price: ticket.price,
        timeInForce: ticket.timeInForce,
        postOnly: ticket.postOnly,
        reduceOnly: false,
        clientOrderId: self.pendingClientOrderId
      });
      self.submitting = true;
      return rest('/orders/' + encodeURIComponent(original.orderId) + '/replace', {
        method: 'POST',
        token: self.ixToken,
        body: body
      }).then(function (res) {
        self.submitting = false;
        var verdict = ixOrderOutcome.classifyReplace(res);
        if (verdict.kind === 'unknown') {
          self.recordUnknownOutcome('amend', verdict, {
            orderId: original.orderId,
            clientOrderId: self.pendingClientOrderId,
            symbol: original.symbol,
            reconcileTarget: verdict.state === 'CANCEL_UNKNOWN' ? 'original' : 'replacement',
            path: 'CANCEL_REPLACE'
          });
          self.loadAccount();
          return;
        }
        if (verdict.kind === 'applied') {
          self.amendOrder = null;
          self.pendingClientOrderId = '';
          self.form.amount = '';
          self.form.price = '';
          self.form.stopPrice = '';
          self.orderValidationError = '';
          self.liveAnnounce = self.$t('exchange.residual.amendReplaceSuccess');
          self.$Notice.success({ title: self.liveAnnounce, desc: original.symbol });
          self.accountTab = 'open';
          self.loadAccount();
          return;
        }
        var reason = verdict.reasonCode || (res && res.data && res.data.code) || 'REPLACE_REFUSED';
        var message = self.$t('exchange.residual.amendRefused', { reason: reason });
        self.amendOrder = null;
        self.pendingClientOrderId = '';
        self.focusOrderError(message);
        self.$Notice.error({ title: self.$t('exchange.residual.amend'), desc: message });
        self.loadAccount();
      });
    },

    recordUnknownOutcome(action, verdict, details) {
      var detail = details || {};
      this.pendingOutcome = {
        action: action,
        phase: 'unknown',
        clientOrderId: detail.clientOrderId || null,
        orderId: detail.orderId || null,
        symbol: detail.symbol === undefined ? this.currentCoin.symbol : detail.symbol,
        scope: detail.scope || null,
        targetOrderIds: Array.isArray(detail.targetOrderIds) ? detail.targetOrderIds.slice() : [],
        targetCount: detail.targetCount == null ? null : detail.targetCount,
        reconcileTarget: detail.reconcileTarget || (action === 'cancel' ? 'original' : (action === 'cancel_all' ? 'target_orders' : 'replacement')),
        path: detail.path || null,
        verdict: verdict
      };
      if (detail.clientOrderId) this.pendingClientOrderId = detail.clientOrderId;
      this.reconcilingOutcome = false;
      this.releaseDupTabSubmitLock();
      this.persistPendingOutcome();
      this.liveAnnounce = this.outcomeMessage(this.pendingOutcome);
      this.orderValidationError = this.liveAnnounce;
      this.focusOrderError(this.liveAnnounce);
      this.$Notice.warning({ title: this.outcomeTitle(this.pendingOutcome), desc: this.liveAnnounce });
    },

    nextClientOrderId() {
      var suffix = Math.random().toString(36).slice(2, 12);
      return ('desk-' + Date.now().toString(36) + '-' + suffix).slice(0, 64);
    },

    orderTypeLabel(row) {
      var type = String(row && row.type || '').toUpperCase();
      if (type === 'MARKET_PRICE' || type === 'MARKET') return this.$t('exchange.terminal.typeMarket');
      if (type === 'LIMIT_PRICE' || type === 'LIMIT') return this.$t('exchange.terminal.typeLimit');
      if (type === 'STOP') return this.$t('exchange.hlplus.stop');
      if (type === 'STOP_LIMIT') return this.$t('exchange.hlplus.stopLimit');
      if (type === 'TRAILING_STOP') return this.$t('exchange.hlplus.trailingStop');
      if (type === 'TAKE_PROFIT') return this.$t('exchange.hlplus.takeProfit');
      return type || '—';
    },

    /** Venue market UUID for this pair. Absent → mass-cancel refuses; no invented id. */
    pairMarketId() {
      var coin = this.currentCoin;
      if (coin && coin.id) return String(coin.id);
      if (this.market && this.market.id) return String(this.market.id);
      return '';
    },

    /**
     * Start one explicitly scoped mass-cancel command. Pair scope hits matching
     * mass-cancel through trade. All-markets stays sequential DELETE. Snapshot
     * IDs are retained if the call becomes transport- or service-unknown.
     */
    cancelAllOrders(scope) {
      if (scope !== 'symbol' && scope !== 'all') return;
      if (this.massCancelScope || this.isMassCancelPending) return;
      var rows = scope === 'all' ? (this.allOpenOrders || []) : (this.openOrders || []);
      if (rows.length === 500) {
        return this.warn(this.$t('exchange.residual.cancelAllSnapshotCapped'));
      }
      var marketId = scope === 'symbol' ? this.pairMarketId() : '';
      if (scope === 'symbol' && !marketId) {
        return this.warn(this.$t('exchange.residual.cancelAllMissingMarket'));
      }
      var targetOrderIds = rows
        .map(function(row) { return row && row.orderId ? String(row.orderId) : ''; })
        .filter(function(id) { return !!id; });
      if (!targetOrderIds.length) return;
      var count = targetOrderIds.length;
      var symbol = this.currentCoin && this.currentCoin.symbol;
      var title = scope === 'symbol'
        ? this.$t('exchange.residual.cancelAllSymbolTitle')
        : this.$t('exchange.residual.cancelAllMarketsTitle');
      var content = scope === 'symbol'
        ? this.$t('exchange.residual.cancelAllSymbolConfirm', { symbol: symbol, count: count })
        : this.$t('exchange.residual.cancelAllMarketsConfirm', { count: count });
      this.$Modal.confirm({
        title: title,
        content: content,
        okText: this.$t('exchange.residual.cancelAllConfirm'),
        cancelText: this.$t('exchange.terminal.cancel'),
        onOk: () => {
          if (this.massCancelScope || this.isMassCancelPending) return;
          this.massCancelScope = scope;
          var req = scope === 'symbol'
            ? rest('/markets/' + encodeURIComponent(marketId) + '/orders/mass-cancel', {
              method: 'POST',
              token: this.ixToken,
              body: {}
            })
            : rest('/orders', {
              method: 'DELETE',
              token: this.ixToken,
              query: undefined
            });
          return req.then(res => {
            this.massCancelScope = null;
            const verdict = ixOrderOutcome.classifyCancelAll(res);
            if (verdict.kind === 'unknown') {
              this.recordUnknownOutcome('cancel_all', verdict, {
                scope: scope,
                symbol: scope === 'symbol' ? symbol : null,
                targetOrderIds: targetOrderIds,
                targetCount: count,
                reconcileTarget: 'target_orders'
              });
              this.loadAccount();
              return;
            }
            if (verdict.kind === 'refused') {
              var refuseInput = (res && res.ok)
                ? { reason: verdict.reasonCode, message: verdict.message }
                : res;
              this.$Notice.error({
                title: this.$t('exchange.residual.cancelAllRefusedTitle'),
                desc: ixTrade.orderFailureMessage(refuseInput, 'cancel')
              });
              this.loadAccount();
              return;
            }
            var returned = Array.isArray(verdict.data) ? verdict.data.length : 0;
            if (returned) {
              this.$Notice.success({
                title: this.$t('exchange.residual.cancelAllDone'),
                desc: this.$t('exchange.residual.cancelAllDoneDesc', { count: returned })
              });
            } else {
              this.$Notice.warning({
                title: this.$t('exchange.residual.cancelAllNoop'),
                desc: this.$t('exchange.residual.cancelAllNoopDesc', { count: count })
              });
            }
            this.loadAccount();
          });
        }
      });
    },

    cancelOrder(order) {
      if (this.cancellingId) return;
      this.$Modal.confirm({
        title: this.$t('exchange.terminal.cancelOrderTitle'),
        content: this.$t('exchange.terminal.cancelOrderConfirm'),
        onOk: () => {
          if (this.cancellingId) return;
          this.cancellingId = order.orderId;
          return rest('/orders/' + encodeURIComponent(order.orderId), {
            method: 'DELETE',
            token: this.ixToken
          }).then(res => {
            this.cancellingId = null;
            const verdict = ixOrderOutcome.classify(res, 'cancel');
            if (verdict.kind === 'unknown') {
              this.recordUnknownOutcome('cancel', verdict, {
                orderId: order.orderId,
                clientOrderId: order.clientOrderId,
                symbol: order.symbol
              });
              return;
            }
            if (verdict.kind === 'applied') {
              this.$Notice.success({ title: this.$t('intafaced.trade.cancelled'), desc: order.symbol });
              this.loadAccount();
              return;
            }
            this.$Notice.error({
              title: this.$t('intafaced.trade.cancelFailed'),
              desc: ixTrade.orderFailureMessage(res, 'cancel')
            });
          });
        }
      });
    },

    /**
     * THE WATCHLIST IS LOCAL TO THIS BROWSER, and the rail says so.
     *
     * The vendor stored favourites server-side via `/exchange/favor/*`. Our
     * surface is a CCXT contract and has no favourites endpoint. localStorage
     * is honest here because a watchlist is a display preference, not money or
     * account state — losing it on another device costs nothing and misleads
     * nobody. A star that silently un-set itself on reload would.
     */
    favoritesKey() {
      return 'ix.watchlist.v1';
    },
    loadFavorites() {
      try {
        const raw = window.localStorage.getItem(this.favoritesKey());
        const list = raw ? JSON.parse(raw) : [];
        this.localFavorites = Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
      } catch (e) {
        this.localFavorites = [];
      }
    },
    saveFavorites() {
      try {
        window.localStorage.setItem(this.favoritesKey(), JSON.stringify(this.localFavorites));
      } catch (e) {
        /* private mode / quota — a watchlist is not worth an error toast */
      }
    },
    setFavorite(symbol, next) {
      const at = this.localFavorites.indexOf(symbol);
      if (next && at < 0) this.localFavorites.push(symbol);
      if (!next && at >= 0) this.localFavorites.splice(at, 1);
      this.saveFavorites();
      const row = this.marketMap[symbol];
      if (row) row.isFavor = next;
      if (symbol === this.currentCoin.symbol) this.currentCoinIsFavor = next;
      this.markets = this.markets.slice();
    },
    toggleFavorite() {
      this.setFavorite(this.currentCoin.symbol, !this.currentCoinIsFavor);
    },
    toggleRowFavorite(row) {
      this.setFavorite(row.symbol, !row.isFavor);
    },

    warn(message) {
      this.$Message.warning(message);
    },

    /* ── formatting ────────────────────────────────────────────────────── */

    positiveDecimal(value) {
      return ixMoney.isPositive(value);
    },

    /**
     * A decimal string, printed verbatim.
     *
     * Use this for every money figure that came off the wire. `fmt()` below
     * parses to a float and calls toFixed, which is fine for a derived display
     * number but wrong for a value the ledger produced — it silently rounds at
     * the seventeenth significant digit and it turns a null into a dash only by
     * accident. Null here is explicit and means unknown.
     */
    dec(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    },

    /**
     * A money figure at a fixed number of places — TRUNCATED, never rounded.
     *
     * This used to be `parseFloat(value).toFixed(scale)`, which rounds: a venue
     * quote of 1.45 printed at one place became 1.5, a price the venue never
     * made. The ladder is not only read — clicking a row copies the printed
     * price into the order form, so a rounded display was one click from an
     * order at an invented price. Unreadable stays a dash, never "0.00".
     */
    fmt(value, scale) {
      /* No published scale → absence, not an invented two-decimal format. */
      if (scale == null) return '—';
      const text = ixMoney.toFixedString(value, scale);
      return text === null ? '—' : text;
    },

    /** A decimal RATE ("0.001") as a percent label. A label, never a charge. */
    pctOf(rate, places) {
      const text = ixMoney.multiply(rate, '100', places == null ? 2 : places);
      return text === null ? '—' : text;
    },

    /* Market headline numbers: if the feed is down and the value is zero/empty,
       show a dash so "0.000000" cannot be read as a real print. */
    marketNum(value, scale) {
      if (value === null || value === undefined || value === '') {
        return '—';
      }
      if (typeof value === 'string' && value.trim() !== '' && ixMoney.toBN(value) === null) {
        return this.feedLive ? value : (value || '—');
      }
      if (ixMoney.toBN(value) === null) {
        return '—';
      }
      if (!this.feedLive && !ixMoney.isPositive(value) && ixMoney.compare(value, '0') === 0) {
        return '—';
      }
      return this.fmt(value, scale);
    },

    marketStat(value) {
      if (value == null || value === '' || value === '—') {
        return '—';
      }
      if (!this.feedLive && (value === '0' || value === '0%' || value === '+0%' || value === '-0%')) {
        return '—';
      }
      return value;
    },

    /* Display helper: never paint 0.000000 as a real print. Ladder rows are
       not padded — invalid levels are dropped in applyPlate (A-UI-2). */
    zero(value, scale) {
      /* null = unreadable, 0 = a real zero. Both are a dash: neither is a print. */
      const c = ixMoney.compare(value, '0');
      return c === null || c === 0 ? '—' : this.fmt(value, scale);
    },

    /** Tape/turnover display product — decimal strings only, never float *. */
    turnoverOf(row) {
      if (!row) return null;
      if (row.turnover != null && row.turnover !== '') return row.turnover;
      return ixMoney.multiply(row.price, row.amount);
    },

    /**
     * Truncate toward zero at `scale` places. Empty string for anything that is
     * not a readable positive value — the callers put this straight into an
     * input, and "" is an empty box while "0.00" is a size the user did not ask
     * for. Float `Math.floor(n * 10**scale)` is gone: at eight places the
     * multiply itself lands below the integer and drops a whole unit.
     */
    floor(value, scale) {
      if (!ixMoney.isPositive(value)) {
        return '';
      }
      const text = ixMoney.toFixedString(value, scale);
      return text === null ? '' : text;
    },

    clamp(value, scale) {
      let text = String(value == null ? '' : value).replace(/[^\d.]/g, '');
      const first = text.indexOf('.');
      if (first > -1) {
        text = text.slice(0, first + 1) + text.slice(first + 1).replace(/\./g, '');
        /* Without a published scale, do not invent a digit cap. */
        if (typeof scale === 'number' && isFinite(scale) && scale >= 0) {
          text = text.slice(0, first + 1 + scale);
        }
      }
      return text;
    },

    /* A CSS length, and the one place a float is legitimate — no user reads a
       bar width as a quantity. `ratio` scales in decimal first so the lossy
       division is the last operation rather than the first. */
    barWidth(row, side) {
      const total = side === 'bid' ? this.plate.bidTotal : this.plate.askTotal;
      return (ixMoney.ratio(row.totalAmount, total) * 100).toFixed(2) + '%';
    },

    roseClass(rose) {
      if (!rose) {
        return '';
      }
      const direction = ixMoney.compare(rose, '0');
      if (direction === null || direction === 0) return '';
      return direction < 0 ? 'ix-down' : 'ix-up';
    },

    /* A market order has no price. Its `price` is null on the wire, and
       formatting null through fmt() would print a number. */
    priceLabel(row) {
      return row.type === 'MARKET_PRICE' ? 'Market' : this.dec(row.price);
    },

    /* Wave B9 — partial fill + id tools from data already on the blotter.
       Both figures are printed as the decimal strings the venue sent. */
    fillLabel(row) {
      if (row.tradedAmount === null || row.tradedAmount === undefined) return '—';
      return this.dec(row.tradedAmount) + ' / ' + this.dec(row.amount);
    },
    fillTitle(row) {
      const pct = ixMoney.percentRatio(row.tradedAmount, row.amount, 1);
      return pct === null ? '' : pct + '% filled';
    },
    copyOrderId(row) {
      const id = row && row.orderId != null ? String(row.orderId) : '';
      if (!id) {
        this.$Notice.warning({ title: this.$t('exchange.residual.noOrderId'), desc: this.$t('exchange.residual.noOrderIdDesc') });
        return;
      }
      const done = () => {
        this.$Notice.success({ title: this.$t('exchange.residual.copied'), desc: this.$t('exchange.residual.orderIdClipboard') });
        this.liveAnnounce = 'Order id copied';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(done).catch(() => {
          this.fallbackCopy(id) && done();
        });
      } else if (this.fallbackCopy(id)) {
        done();
      }
    },
    fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    },
    exportOpenOrdersCsv() {
      if (!this.openOrders.length) return;
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [
        ['time', 'symbol', 'type', 'side', 'price', 'amount', 'filled', 'turnover', 'orderId'].join(',')
      ];
      this.openOrders.forEach(row => {
        lines.push(
          [
            esc(this.date(row.time)),
            esc(row.symbol),
            esc(row.type === 'MARKET_PRICE' ? $t('exchange.terminal.typeMarket') : $t('exchange.terminal.typeLimit')),
            esc(row.direction),
            esc(row.type === 'MARKET_PRICE' ? 'Market' : row.price),
            esc(row.amount),
            esc(row.tradedAmount),
            esc(row.turnover),
            esc(row.orderId)
          ].join(',')
        );
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'open-orders.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    statusLabel(rowOrStatus) {
      const row = rowOrStatus && typeof rowOrStatus === 'object' ? rowOrStatus : null;
      const status = row ? row.status : rowOrStatus;
      const verdict = row ? ixOrderOutcome.classifyRow(row) : null;
      if (verdict && verdict.kind === 'unknown') return this.outcomeLabel(row);
      if (status === 'COMPLETED') return 'Filled';
      if (status === 'CANCELED') return 'Cancelled';
      /* Partial: venue said TRADING/open history with fills < size — never invent %. */
      if (row && this.isPartialFill(row)) return 'Partial';
      if (status === 'TRADING') return 'Open';
      return status || '—';
    },

    statusClass(rowOrStatus) {
      const row = rowOrStatus && typeof rowOrStatus === 'object' ? rowOrStatus : null;
      const status = row ? row.status : rowOrStatus;
      const verdict = row ? ixOrderOutcome.classifyRow(row) : null;
      if (verdict && verdict.kind === 'unknown') return 'ix-outcome-unknown';
      if (status === 'COMPLETED') return 'ix-accent';
      if (status === 'CANCELED') return 'ix-dim';
      if (row && this.isPartialFill(row)) return 'ix-partial';
      return '';
    },

    outcomeLabel(row) {
      var verdict = ixOrderOutcome.classifyRow(row);
      if (!verdict || verdict.kind !== 'unknown') return '—';
      return this.$t('exchange.residual.outcomeUnknown') + ' · ' + String(verdict.state || verdict.reasonCode || 'RECONCILING');
    },

    outcomeClass(row) {
      var verdict = ixOrderOutcome.classifyRow(row);
      return verdict && verdict.kind === 'unknown' ? 'ix-outcome-unknown' : 'ix-dim';
    },

    outcomeTitle(outcome) {
      if (outcome && outcome.action === 'cancel_all') return this.$t('exchange.residual.cancelAllUnknownTitle');
      if (outcome && outcome.action === 'cancel') return this.$t('exchange.residual.cancelUnknownTitle');
      if (outcome && outcome.action === 'amend') return this.$t('exchange.residual.amendUnknownTitle');
      return this.$t('exchange.residual.submitUnknownTitle');
    },

    outcomeMessage(outcome) {
      if (!outcome) return '';
      if (outcome.phase === 'reconciling') return this.$t('exchange.residual.reconciling');
      if (outcome.action === 'cancel_all' && outcome.remainingTargetOrderIds && outcome.remainingTargetOrderIds.length) {
        return this.$t('exchange.residual.cancelAllUnknownOpen', { count: outcome.remainingTargetOrderIds.length });
      }
      if (outcome.action === 'cancel_all') return this.$t('exchange.residual.cancelAllUnknownCopy');
      if (outcome.action === 'cancel' && outcome.lastReadStatus === 'TRADING') {
        return this.$t('exchange.residual.cancelUnknownOpen');
      }
      if (outcome.action === 'cancel') return this.$t('exchange.residual.cancelUnknownCopy');
      if (outcome.action === 'amend' && outcome.path === 'NATIVE_AMEND') {
        return this.$t('exchange.residual.amendNativeUnknownCopy');
      }
      if (outcome.action === 'amend' && outcome.verdict && outcome.verdict.state === 'CANCEL_UNKNOWN') {
        return this.$t('exchange.residual.amendCancelUnknownCopy');
      }
      if (outcome.action === 'amend' && outcome.verdict && outcome.verdict.state === 'SUBMIT_UNKNOWN') {
        return this.$t('exchange.residual.amendSubmitUnknownCopy');
      }
      if (outcome.action === 'amend' && outcome.verdict && outcome.verdict.reasonCode) {
        return this.$t('exchange.residual.amendTerminalUnknownCopy', { reason: outcome.verdict.reasonCode });
      }
      if (outcome.action === 'amend') return this.$t('exchange.residual.amendUnknownCopy');
      return this.$t('exchange.residual.submitUnknownCopy');
    },

    isPartialFill(row) {
      if (!row) return false;
      return ixMoney.isPositive(row.amount) &&
        ixMoney.isPositive(row.tradedAmount) &&
        ixMoney.compare(row.tradedAmount, row.amount) < 0;
    },

    exportHistoryOrdersCsv() {
      if (!this.historyOrders.length) return;
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [
        ['time', 'symbol', 'type', 'side', 'price', 'amount', 'filled', 'turnover', 'status', 'orderId'].join(',')
      ];
      this.historyOrders.forEach(row => {
        lines.push(
          [
            esc(this.date(row.time)),
            esc(row.symbol),
            esc(row.type === 'MARKET_PRICE' ? $t('exchange.terminal.typeMarket') : $t('exchange.terminal.typeLimit')),
            esc(row.direction),
            esc(row.type === 'MARKET_PRICE' ? 'Market' : row.price),
            esc(row.amount),
            esc(row.tradedAmount),
            esc(row.turnover),
            esc(this.statusLabel(row)),
            esc(row.orderId)
          ].join(',')
        );
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'order-history.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.liveAnnounce = 'Order history CSV downloaded';
    },

    time(tick) {
      return tick ? moment(tick).format('HH:mm:ss') : '—';
    },

    date(tick) {
      return tick ? moment(tick).format('MM-DD HH:mm:ss') : '—';
    }
  }
};
</script>

<style scoped lang="scss">
/* Palette comes from assets/css/intafaced.css. Fallbacks keep the terminal
   readable if this page is ever rendered before that sheet loads. */
$orange: var(--ix-orange, #c8c8c8);
$up: var(--ix-up, #00b275);
$down: var(--ix-down, #ff4a68);
$text: var(--ix-text, #f2f2f2);
$dim: var(--ix-text-dim, #9a9a9a);
$faint: var(--ix-text-faint, #6b6b6b);
$hair: var(--ix-hairline, rgba(255, 255, 255, 0.09));
$surface: var(--ix-surface, rgba(255, 255, 255, 0.045));
$radius: var(--ix-radius, 4px);
$radius-sm: var(--ix-radius-sm, 3px);

.ix-terminal {
  --row: 24px;
  /* B2 density: fill the viewport under the global nav; columns share one height. */
  --nav-chrome: 56px;
  --desk-pad: 16px;
  --head-h: 64px;
  --desk-h: calc(100vh - var(--nav-chrome) - var(--desk-pad));
  --col-h: calc(var(--desk-h) - var(--head-h) - 8px);
  min-height: var(--desk-h);
  box-sizing: border-box;
  padding: 8px;
  color: $text;
  font-size: 12px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}

.ix-terminal.is-perp {
  --head-h: 116px;
}

/* ── shared surface ─────────────────────────────────────────────────────
   B1: solid P21 panels on the desk — no default glass blur (anti-slop). */
.ix-panel {
  position: relative; /* B5 resizer anchors */
  background: var(--ix-panel, #12151c);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: 1px solid $hair;
  border-radius: $radius;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* ── header ───────────────────────────────────────────────────────────── */
.ix-head {
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 10px 18px;
  margin-bottom: 8px;
  background: var(--ix-panel, #12151c);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: 1px solid $hair;
  border-radius: $radius;
  overflow-x: auto;
}

.ix-perp-strip {
  display: flex;
  align-items: stretch;
  gap: 1px;
  margin: -1px 0 8px;
  overflow-x: auto;
  border: 1px solid $hair;
  border-radius: $radius-sm;
  background: $hair;

  dl {
    min-width: 128px;
    margin: 0;
    padding: 7px 12px;
    background: var(--ix-panel, #12151c);
  }

  dt {
    color: $faint;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  dd {
    margin: 2px 0 0;
    color: $text;
    font-weight: 650;
    white-space: nowrap;
  }

  small {
    color: $dim;
    white-space: nowrap;
  }
}

.ix-head-pair {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.ix-pair {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.ix-pair-switch {
  appearance: none;
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  margin: 0;
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  background: transparent;
  color: $text;
  cursor: pointer;
}
.ix-pair-switch:hover,
.ix-pair-switch:focus-visible,
.ix-pair-switch[aria-expanded='true'] {
  border-color: $hair;
  background: var(--ix-surface-raised, #161a22);
  outline: none;
}
.ix-pair-caret {
  margin-left: 5px;
  color: $faint;
  font-size: 12px;
}
.ix-pair-base {
  color: $faint;
  font-weight: 500;
  font-size: 13px;
}

.ix-info-icon {
  color: $faint;
  cursor: help;
}
.ix-coin-info {
  color: $dim;
  line-height: 1.6;
}
.ix-coin-link {
  text-align: right;
  margin-top: 6px;
}

.ix-star {
  background: none;
  border: 0;
  padding: 0 2px;
  cursor: pointer;
  color: $faint;
  line-height: 1;
  &.is-on {
    color: $orange;
  }
  &:hover {
    color: $orange;
  }
}
.ix-star-inline {
  display: inline-flex;
  vertical-align: middle;
  margin-right: 3px;
}

.ix-head-last {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
}
.ix-last {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.ix-last-alt {
  font-size: 11px;
  color: $faint;
}

.ix-stat {
  flex: 0 0 auto;
  margin: 0;
  dt {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: $faint;
    white-space: nowrap;
  }
  dd {
    margin: 2px 0 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    em {
      font-style: normal;
      font-weight: 400;
      color: $faint;
      font-size: 11px;
    }
  }
}

/* A-UI-SUB — sits before live status; margin-left:auto on status still pins right. */
.ix-head-sub {
  margin-left: auto;
  flex: 0 1 auto;
  min-width: 0;
}

.ix-head-snapshot {
  flex: 0 1 auto;
  max-width: 11rem;
  margin-left: 8px;
  font-size: 10px;
  line-height: 1.2;
  color: $dim;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ix-head-status {
  margin-left: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  max-width: 42%;
  font-size: 10px;
  color: $dim;
}

.ix-channel-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 6px;
  border: 1px solid $hair;
  border-radius: 0;
  background: #080808;
  color: $dim;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.ix-channel-chip.is-live,
.ix-channel-chip.is-empty {
  color: $text;
  border-color: #3a3a3a;
}
.ix-channel-chip.is-failed,
.ix-channel-chip.is-degraded {
  color: $faint;
  border-color: #2a2a2a;
}
.ix-channel-chip.is-unset {
  color: $faint;
  opacity: 0.72;
}

.ix-desk-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 4px 8px;
  border-bottom: 1px solid $hair;
  background: #050505;
  color: $dim;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ix-desk-banner-lock {
  color: $text;
}
.ix-lock-toggle {
  margin-left: auto;
  min-height: 24px;
  min-width: 24px;
  padding: 0 10px;
  border: 1px solid $hair;
  border-radius: 0;
  background: transparent;
  color: $text;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}
.ix-lock-toggle[aria-pressed='true'] {
  background: #111;
}

.ix-book-spread-strip {
  flex: 0 0 auto;
  min-height: 24px;
  padding: 4px 8px;
  border-bottom: 1px solid $hair;
  color: $faint;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* ── layout ─────────────────────────────────────────────────────────────
   Density (design bar §3.2): fixed four-column terminal — markets | centre |
   book rail | order form — shared gap token so panels read as one product. */
.ix-body {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr) 252px 296px;
  gap: 4px;
  align-items: stretch;
  height: var(--col-h);
  min-height: 520px;
}

/* B5 — column splitters (desktop only; hidden under 1500px with markets). */
.ix-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 6;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
.ix-resizer:hover,
.ix-resizer:focus-visible {
  background: rgba(200, 200, 200, 0.22);
}
.ix-resizer-e {
  right: 0;
}
.ix-resizer-w {
  left: 0;
}
@media (max-width: 1499px) {
  .ix-resizer {
    display: none;
  }
}
/* Global during drag — avoid text selection while resizing. */
body.ix-resizing-cols {
  cursor: col-resize !important;
  user-select: none !important;
}

.ix-centre {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  min-width: 0;
  height: 100%;
  min-height: 0;
}

/* ── tabs ─────────────────────────────────────────────────────────────── */
.ix-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-bottom: 1px solid $hair;
  flex: 0 0 auto;

  button {
    appearance: none;
    background: none;
    border: 0;
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    color: $faint;
    cursor: pointer;
    position: relative;
    white-space: nowrap;
    transition: color 0.16s ease;

    sup {
      font-size: 9px;
      color: $orange;
      margin-left: 3px;
      top: -0.4em;
    }

    &:hover {
      color: $text;
    }
    &.is-active {
      color: $orange;
      &::after {
        content: '';
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: -1px;
        height: 2px;
        border-radius: 999px;
        background: $orange;
      }
    }
  }
}

.ix-tabs-sm button {
  padding: 6px 9px;
  font-size: 11px;
}

/* M07-R03: compact only the existing market-data chrome. The 24px row floor
   remains intact for pointer/touch access; density comes from type and inset. */
.ix-markets > .ix-tabs button,
.ix-rail > .ix-tabs button {
  min-height: 28px;
  padding: 4px 8px;
  font-size: 11px;
}

.ix-intervals {
  margin-left: auto;
  display: flex;
  gap: 1px;
  button {
    padding: 4px 7px;
    font-size: 11px;
    font-weight: 500;
    border-radius: $radius-sm;
    &.is-active {
      color: $orange;
      background: var(--ix-orange-soft, rgba(200, 200, 200, 0.12));
      &::after {
        display: none;
      }
    }
  }
}
.ix-layout-reset {
  flex: 0 0 auto;
  margin-left: 5px;
  padding: 4px 7px !important;
  color: $dim !important;
  font-size: 10px !important;
  white-space: nowrap;
}
.ix-layout-notice {
  flex: 0 0 auto;
  margin: 0;
  padding: 4px 9px;
  border-bottom: 1px solid $hair;
  color: $faint;
  font-size: 10px;
  line-height: 1.35;
}
.ix-indicator-divider {
  width: 1px;
  height: 18px;
  margin: 2px 3px;
  background: $hair;
}
.ix-chart-provenance {
  flex: 0 0 auto;
  margin: 0;
  padding: 4px 9px;
  border-bottom: 1px solid $hair;
  color: $faint;
  font-size: 10px;
  line-height: 1.35;
}
.ix-chart-controls {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  padding: 4px 9px;
  border-bottom: 1px solid $hair;
}
.ix-chart-controls button {
  min-width: 24px;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid $hair;
  border-radius: 0;
  background: transparent;
  color: $dim;
  font-size: 11px;
  cursor: pointer;
}
.ix-chart-controls button:hover,
.ix-chart-controls button:focus-visible {
  border-color: $faint;
  color: $text;
}
.ix-chart-summary {
  flex: 0 0 auto;
  margin: 0;
  padding: 4px 9px;
  border-bottom: 1px solid $hair;
  color: $dim;
  font-size: 10px;
  line-height: 1.4;
}

/* ── markets ──────────────────────────────────────────────────────────── */
.ix-markets {
  height: 100%;
  min-height: 0;
}
.ix-markets-search {
  position: relative;
  padding: 5px 6px;
  border-bottom: 1px solid $hair;
  input {
    width: 100%;
    height: 26px;
    padding: 0 8px;
    padding-right: 32px;
    font-size: 11px;
  }
}
.ix-market-drawer-close {
  display: none;
  position: absolute;
  top: 9px;
  right: 10px;
  width: 26px;
  height: 26px;
  border: 0;
  background: transparent;
  color: $dim;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.ix-market-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 54px;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: var(--row);
  padding: 2px 7px;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  color: $dim;
  font-size: 11px;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.045);
    color: $text;
  }
  &.is-current {
    border-left-color: $orange;
    background: var(--ix-orange-soft, rgba(200, 200, 200, 0.12));
    color: $text;
  }
}
.ix-market-name {
  font-weight: 600;
  color: $text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  em {
    font-style: normal;
    font-weight: 400;
    color: $faint;
  }
}

/* ── column heads and scrollers ───────────────────────────────────────── */
.ix-thead {
  display: grid;
  gap: 4px;
  min-height: 24px;
  padding: 4px 7px;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: $faint;
  border-bottom: 1px solid $hair;
  flex: 0 0 auto;
}
.ix-thead-markets {
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 54px;
}
.ix-thead-book {
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr);
}
.ix-thead-trades {
  grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr);
}
.ix-thead-trades-full {
  grid-template-columns: 90px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
}

/* Every list lives in a fixed-height scroller. Nothing on this page is
   allowed to grow the document — that is what made the old terminal creep. */
.ix-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}

/* Honesty recipes — loading / empty / error stay visually distinct (§3.1). */
.ix-empty {
  padding: 22px 12px;
  text-align: center;
  color: $faint;
  font-size: var(--type-11, 11px);
}
.ix-dualbook {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid rgba(200, 200, 200, 0.35);
  border-radius: 6px;
  background: rgba(200, 200, 200, 0.06);
  color: #c8cdd4;
  font-size: 12.5px;
  line-height: 1.5;
}
.ix-dualbook strong {
  color: #c8c8c8;
  font-weight: 600;
}
.ix-empty-error {
  color: $down;
  border-left: 2px solid $down;
  text-align: left;
  padding-left: var(--space-3, 12px);
}
.ix-empty-loading {
  font-style: italic;
  color: $dim;
}
.ix-empty-note {
  padding: 8px 12px 0;
  text-align: left;
  color: $faint;
  font-size: 10px;
  line-height: 1.35;
}
.ix-empty-abs {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 2;
}
/* Chart empty: high-contrast line over the kline host (not $faint on black). */
.ix-empty-chart {
  margin: 0 auto;
  max-width: 28rem;
  padding: 10px 14px;
  border: 1px solid rgba(200, 205, 212, 0.28);
  border-radius: 4px;
  background: rgba(12, 14, 18, 0.92);
  color: #c8cdd4;
  font-size: var(--type-12, 12px);
  line-height: 1.4;
  text-align: center;
}

/* ── chart ────────────────────────────────────────────────────────────── */
.ix-chart-panel {
  flex: 1 1 auto;
  height: auto;
  min-height: 280px;
}
.ix-chart-capabilities {
  flex: 0 0 auto;
  margin: 0;
  padding: 4px 10px;
  border-bottom: 1px solid $hair;
  color: $faint;
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ix-chart-capabilities button {
  margin: 0 10px 0 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: $faint;
  font: inherit;
  cursor: not-allowed;
}
.ix-chart-capabilities button.ix-chart-reprice:not(:disabled) {
  color: $text;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.ix-chart-reprice-stage {
  flex: 0 0 auto;
  padding: 6px 9px;
  border-bottom: 1px solid $hair;
  background: rgba(255, 255, 255, 0.025);
  color: $dim;
  font-size: 10px;
}
.ix-chart-reprice-stage dl {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
  margin: 0 0 5px;
}
.ix-chart-reprice-stage dl div { min-width: 0; }
.ix-chart-reprice-stage dt {
  color: $faint;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ix-chart-reprice-stage dd {
  margin: 1px 0 0;
  overflow: hidden;
  color: $text;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ix-chart-reprice-actions {
  display: flex;
  gap: 4px;
}
.ix-chart-reprice-actions button {
  min-height: 24px;
  padding: 3px 7px;
  border: 1px solid $hair;
  border-radius: 0;
  background: transparent;
  color: $text;
  font-size: 10px;
}
.ix-chart-reprice-actions button:disabled { color: $faint; }
.ix-chart-reprice-actions button:not(:disabled) { cursor: pointer; }
.ix-chart-reprice-actions button:focus-visible { outline: 2px solid $text; outline-offset: 1px; }
.ix-chart-reprice-stage p { margin: 4px 0 0; line-height: 1.35; }
@media (max-width: 700px) {
  .ix-chart-reprice-stage dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ix-chart-reprice-actions { flex-wrap: wrap; }
  .ix-chart-reprice-actions button { min-height: 44px; }
}
.ix-chart-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* The widget writes an iframe in here. With `fullscreen` off and `autosize`
   on it inherits 100% of this box, which is why the box must be definite. */

.ix-chart-attr {
  position: relative;
  z-index: 2;
  margin: 0;
  padding: 4px 10px 6px;
  font-size: 11px;
  line-height: 1.3;
  opacity: 0.55;
  text-align: right;
}
.ix-chart-attr a {
  color: inherit;
  text-decoration: underline;
}
.ix-kline,
.ix-depth-host {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: 0;
}
/* Dim the host when honesty empty is showing so the status line wins. */
.ix-kline.is-empty {
  opacity: 0.22;
  pointer-events: none;
}
.ix-kline:focus-visible {
  outline: 2px solid #c8c8c8;
  outline-offset: -2px;
}

.ix-book-full {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: $hair;
}
.ix-book-state {
  grid-column: 1 / -1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: var(--ix-bg, #000);
}
.ix-book-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ix-bg, #000);
}

.ix-trades-full {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ── order book ───────────────────────────────────────────────────────── */
.ix-rail {
  height: 100%;
  min-height: 0;
}
.ix-rail-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.ix-book-side {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ix-book-asks {
  justify-content: flex-end;
}

.ix-book-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px;
  width: 100%;
  padding: 2px 7px;
  min-height: var(--row);
  align-items: center;
  background: none;
  border: 0;
  color: $dim;
  font-size: 11px;
  line-height: 1.2;
  cursor: pointer;
  text-align: right;

  > span {
    position: relative;
    z-index: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
}

.ix-depth-bar {
  position: absolute !important;
  top: 1px;
  bottom: 1px;
  right: 0;
  z-index: 0 !important;
  border-radius: 2px 0 0 2px;
}
.is-bid .ix-depth-bar {
  background: rgba(0, 178, 117, 0.16);
}
.is-ask .ix-depth-bar {
  background: rgba(255, 74, 104, 0.14);
}

.ix-book-mid {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 7px;
  border-top: 1px solid $hair;
  border-bottom: 1px solid $hair;
  flex: 0 0 auto;
}
.ix-book-price {
  font-size: 15px;
  font-weight: 700;
}
.ix-book-spread {
  margin-left: auto;
  font-size: 10px;
  color: $faint;
}

.ix-book-group {
  margin-left: 6px;
  background: transparent;
  color: inherit;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 3px;
  font-size: 11px;
  padding: 1px 4px;
  max-width: 64px;
}
.ix-book-modes {
  margin-left: auto;
  display: flex;
  gap: 3px;
}
.ix-book-mode {
  padding: 4px 3px !important;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: 4px;
  i {
    display: block;
    width: 12px;
    height: 3px;
    border-radius: 1px;
    background: $faint;
  }
  &.is-all i:first-child,
  &.is-asks i {
    background: $down;
  }
  &.is-all i:last-child,
  &.is-bids i {
    background: $up;
  }
  &.is-asks i:last-child,
  &.is-bids i:first-child {
    opacity: 0.28;
  }
  &::after {
    display: none !important;
  }
  &.is-active {
    background: rgba(255, 255, 255, 0.09);
  }
}

/* ── trades ───────────────────────────────────────────────────────────── */
.ix-trade-row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px;
  padding: 2px 7px;
  min-height: var(--row);
  align-items: center;
  font-size: 11px;
  line-height: 1.2;
  color: $dim;
  &.is-wide {
    grid-template-columns: 90px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  }
  &:hover {
    background: rgba(255, 255, 255, 0.04);
  }
}

/* ── account panel ────────────────────────────────────────────────────── */
.ix-account {
  flex: 0 0 200px;
  height: 200px;
  min-height: 160px;
}
.ix-account-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* B14 — cheap virtualization assist for long blotters */
.ix-table tbody tr {
  content-visibility: auto;
  contain-intrinsic-size: 0 32px;
}
.ix-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;

  th {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 7px 10px;
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: $faint;
    background: var(--ix-surface-solid, #0d0d0d);
    border-bottom: 1px solid $hair;
    white-space: nowrap;
  }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    color: $dim;
    white-space: nowrap;
  }
  tbody tr:hover td {
    background: rgba(255, 255, 255, 0.035);
  }
}
.ix-strong {
  color: $text;
  font-weight: 600;
}

.ix-cancel {
  background: #0b0b0b;
  border: 1px solid $hair;
  border-radius: 0;
  min-height: 44px;
  min-width: 44px;
  padding: 0 12px;
  font-size: 10px;
  color: $dim;
  cursor: pointer;
  box-shadow: none;
  &:hover:not(:disabled) {
    border-color: #343434;
    color: $text;
  }
  &:disabled {
    background: #111;
    color: $faint;
    cursor: not-allowed;
  }
}
.ix-link {
  color: $orange;
}

/* ── order entry ──────────────────────────────────────────────────────── */
.ix-order {
  height: 100%;
  min-height: 0;
}
.ix-ticket-refusal {
  margin: 0;
  padding: 10px 9px;
  color: $dim;
  background: #0b0b0b;
  border-bottom: 1px solid #343434;
}
.ix-ticket-refusal strong,
.ix-ticket-refusal span { display: block; }
.ix-ticket-refusal strong {
  margin-bottom: 4px;
  color: $text;
  font-size: 10px;
  line-height: 1.2;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.ix-ticket-refusal span { font-size: 10px; line-height: 1.35; }
.ix-order.is-refused > .ix-side-toggle:not(.ix-mode-strip) button,
.ix-order.is-refused > .ix-side-toggle:not(.ix-mode-strip) button.is-active {
  color: $faint;
  background: #080808;
  border-color: $hair;
}
.ix-order.is-refused .ix-order-body { background: #030303; }
.ix-side-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 10px 10px 6px;
  flex: 0 0 auto;

  button {
    appearance: none;
    border: 1px solid $hair;
    background: rgba(255, 255, 255, 0.04);
    border-radius: $radius-sm;
    padding: 7px 0;
    font-size: 12px;
    font-weight: 700;
    color: $dim;
    cursor: pointer;
    transition: all 0.16s ease;

    &:first-child.is-active {
      background: rgba(0, 178, 117, 0.16);
      border-color: rgba(0, 178, 117, 0.5);
      color: $up;
    }
    &:last-child.is-active {
      background: rgba(255, 74, 104, 0.16);
      border-color: rgba(255, 74, 104, 0.5);
      color: $down;
    }
  }
}
/* Order type Limit|Market — one control group, not scattered (§3.2). */
.ix-type-tabs {
  margin: 0 var(--space-2, 8px);
  border: 1px solid $hair;
  border-radius: $radius-sm;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid $hair;
  button {
    flex: 1 1 0;
  }
}

.ix-order-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3, 12px) var(--space-2, 10px);
}
.ix-order .ix-type-tabs {
  overflow-x: auto;
  scrollbar-width: thin;
}
.ix-order .ix-type-tabs button {
  flex: 0 0 auto;
  padding-right: 9px;
  padding-left: 9px;
}

.ix-field {
  margin-bottom: var(--space-3, 10px);
  label {
    display: block;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: $faint;
    margin-bottom: 4px;
  }
}
.ix-input {
  position: relative;
  input {
    width: 100%;
    height: var(--control-h, 34px);
    min-height: var(--control-h, 34px);
    padding: 0 52px 0 10px;
    font-size: var(--type-13, 13px);
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
  }
  &.is-disabled input {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
.ix-unit {
  position: absolute;
  right: 10px;
  top: 0;
  height: var(--control-h, 34px);
  line-height: var(--control-h, 34px);
  font-size: var(--type-11, 11px);
  color: $faint;
  pointer-events: none;
}

.ix-slider {
  margin: 14px 0 12px;

  input[type='range'] {
    width: 100%;
    height: 4px;
    appearance: none;
    -webkit-appearance: none;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    outline: none;
    cursor: pointer;
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 999px;
      background: $orange;
      border: 2px solid #000;
      box-shadow: 0 0 0 1px var(--ix-orange-glow, rgba(200, 200, 200, 0.28));
      cursor: pointer;
    }
    &::-moz-range-thumb {
      width: 11px;
      height: 11px;
      border-radius: 999px;
      background: $orange;
      border: 2px solid #000;
      cursor: pointer;
    }
  }
}
.ix-slider-steps {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  margin-top: 9px;

  button {
    appearance: none;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid $hair;
    border-radius: $radius-sm;
    padding: 4px 0;
    font-size: 10px;
    color: $dim;
    cursor: pointer;
    &:hover:not(:disabled) {
      border-color: $orange;
      color: $orange;
    }
    &.is-active {
      background: var(--ix-orange-soft, rgba(200, 200, 200, 0.12));
      border-color: $orange;
      color: $orange;
    }
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
}

.ix-meta {
  margin: 0 0 14px;
  > div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 3px 0;
  }
  /* B9: disclosure sits under the fee row full-width. */
  > div.ix-fee-row {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  dt {
    font-size: 11px;
    color: $faint;
  }
  dd {
    margin: 0;
    font-size: 11px;
    color: $text;
    em {
      font-style: normal;
      color: $faint;
    }
  }
}
.ix-fee-help {
  appearance: none;
  margin-left: 6px;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent;
  color: $faint;
  font-size: 10px;
  line-height: 14px;
  cursor: pointer;
  vertical-align: middle;
  &:hover,
  &[aria-expanded='true'] {
    color: $orange;
    border-color: rgba(200, 200, 200, 0.55);
  }
}
.ix-fee-disclosure {
  flex: 1 1 100%;
  margin: 6px 0 2px;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.28);
  font-size: 11px;
  line-height: 1.4;
  color: $dim;
  strong {
    color: $text;
    font-weight: 600;
  }
}

.ix-submit {
  width: 100%;
  appearance: none;
  border: 0;
  border-radius: 0;
  min-height: 44px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  color: #c8c8c8;
  background: #1a1a1a;
  box-shadow: none;
  cursor: pointer;

  &.is-buy {
    background: var(--ix-up);
    color: #04170f;
    box-shadow: none;
  }
  &.is-sell {
    background: var(--ix-down);
    color: #1a0409;
    box-shadow: none;
  }
  &:hover:not(:disabled) {
    filter: none;
    transform: none;
  }
  &:disabled {
    background: #111;
    color: #6a6a6a;
    box-shadow: none;
    cursor: not-allowed;
  }
}

.ix-order-note {
  margin-top: 10px;
  text-align: center;
  font-size: 11px;
  color: $faint;
}
.ix-order-note.ix-order-error {
  color: #ff6b6b;
  font-weight: 500;
}

/* ── shared atoms ─────────────────────────────────────────────────────── */
.ix-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}
.ix-up {
  color: $up;
}
.ix-down {
  color: $down;
}
.ix-dim {
  color: $faint;
}
.ix-partial {
  color: var(--ix-orange-light, #e2e2e2);
  font-weight: 600;
}
.ix-accent {
  color: $orange;
}

/* ── responsive ───────────────────────────────────────────────────────── */
@media (max-width: 1500px) {
  .ix-body {
    grid-template-columns: minmax(0, 1fr) 236px 280px;
  }
  .ix-markets {
    display: none;
  }
  .ix-markets.is-open {
    display: flex;
    position: fixed;
    top: 72px;
    bottom: 16px;
    left: 16px;
    z-index: 80;
    width: min(320px, calc(100vw - 32px));
    height: auto;
    border-color: rgba(200, 200, 200, 0.45);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.72);
  }
  .ix-markets.is-open .ix-market-drawer-close {
    display: block;
  }
}

@media (max-width: 1180px) {
  .ix-body {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
  .ix-rail {
    display: none;
  }
  .ix-order {
    grid-column: auto;
    height: 100%;
  }
  .ix-head {
    gap: 18px;
  }
}

@media (max-width: 700px) {
  .ix-body {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
    min-height: 0;
  }
  .ix-rail {
    display: none;
  }
  /* B4 — keep pair/feed visible. The full ticket remains in document flow so
     it never covers the chart or blotter on a 390px monitor viewport. */
  .ix-head {
    position: sticky;
    top: 0;
    z-index: 25;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 6px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  }
  .ix-order {
    height: auto;
    max-height: none;
    position: relative;
    bottom: auto;
    z-index: 1;
    box-shadow: none;
    background: var(--ix-panel, #12151c);
    /* Focus ring when ticket is active (mobile focus-trap affordance). */
    &:focus-within {
      outline: 1px solid rgba(200, 200, 200, 0.55);
      outline-offset: 0;
    }
  }
  .ix-order-body {
    overflow: visible;
    max-height: none;
  }
  .ix-submit {
    min-height: 48px;
    font-size: 15px;
    position: static;
  }
  .ix-chart-panel {
    height: 280px;
  }
  .ix-account {
    max-height: 360px;
  }
  /* Panic cancel stays reachable on open-orders blotter */
  .ix-actions {
    position: sticky;
    right: 0;
    background: var(--ix-panel, #12151c);
  }
  .ix-cancel {
    min-height: 44px;
    min-width: 72px;
    padding: 0 12px;
  }
  .ix-kbd-hint {
    display: none;
  }
  .ix-stat {
    min-width: 72px;
  }
}

@media (max-width: 520px) {
  .ix-markets {
    display: none;
  }
  .ix-markets.is-open {
    display: flex !important;
    position: fixed;
    top: 72px;
    bottom: 16px;
    left: 16px;
    z-index: 80;
    width: min(320px, calc(100vw - 32px));
    height: auto;
    border-color: rgba(200, 200, 200, 0.45);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.72);
  }
  .ix-chart-panel {
    height: 240px;
  }
  .ix-head {
    padding: 8px 10px;
  }
  .ix-head .ix-stat:nth-of-type(n + 2),
  .ix-head-snapshot,
  .ix-head-sub {
    display: none;
  }
  .ix-head-status {
    margin-left: auto;
  }
}

/* L0-L7 desk composition. Engines, money paths and persisted preferences are
   unchanged; these rules only arrange their existing surfaces. */
.ix-terminal {
  --nav-chrome: 0px !important;
  --head-h: 48px !important;
  --desk-h: 100vh !important;
  --col-h: calc(100vh - 49px) !important;
  --row: 24px !important;
  min-height: 100vh !important;
  padding: 0 !important;
  overflow: hidden;
}
.ix-head {
  min-height: 48px !important;
  height: 48px !important;
  margin: 0 !important;
  padding: 0 10px !important;
  overflow: visible;
  border-width: 0 0 1px !important;
  flex-wrap: nowrap;
}
.ix-desk-brand,
.ix-desk-account,
.ix-desk-plane a { color: $text; text-decoration: none; }
.ix-desk-brand {
  flex: 0 0 138px;
  border-right: 1px solid $hair;
  font: 700 12px/48px ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.08em;
}
.ix-desk-plane {
  display: flex;
  flex: 0 0 auto;
  height: 26px;
  margin-left: 10px;
  border: 1px solid $hair;
}
.ix-desk-plane a {
  min-width: 38px;
  padding: 0 7px;
  color: $faint;
  font-size: 9px;
  line-height: 24px;
  letter-spacing: 0.08em;
  text-align: center;
}
.ix-desk-plane a + a { border-left: 1px solid $hair; }
.ix-desk-plane a.is-active {
  background: #111;
  color: $text;
  box-shadow: inset 0 -1px 0 $text;
}
.ix-desk-account {
  flex: 0 0 auto;
  min-width: 68px;
  height: 26px;
  margin-left: 8px;
  padding: 0 9px;
  border: 1px solid $hair;
  font: 10px/24px ui-sans-serif, system-ui, sans-serif;
  text-align: center;
}
.ix-head .ix-stat:nth-of-type(n + 2),
.ix-head-snapshot,
.ix-head-sub { display: none; }
.ix-head-pair,
.ix-head-last,
.ix-head .ix-stat,
.ix-head-status { min-height: 30px; padding: 0 10px; }
.ix-head-status { margin-left: auto; }

.ix-body {
  grid-template-columns: var(--ix-market-column-width, 200px) minmax(0, 1fr) var(--ix-right-column-width, 300px) !important;
  grid-template-rows: minmax(260px, 34%) minmax(0, 66%);
  grid-template-areas: "markets centre rail" "markets centre ticket";
  gap: 1px !important;
  height: var(--col-h) !important;
  min-height: 0 !important;
}
.ix-markets { grid-area: markets; display: flex !important; }
.ix-centre { grid-area: centre; }
.ix-rail { grid-area: rail; display: flex !important; }
.ix-order { grid-area: ticket; height: 100% !important; }
.ix-chart-panel { min-height: 420px; }
.ix-account { flex: 0 0 120px; height: 120px; min-height: 120px; }

.ix-mode-strip {
  display: flex;
  gap: 0;
  padding: 0;
  border-bottom: 1px solid $hair;
}
.ix-mode-strip button {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 28px;
  padding: 0 4px;
  border-width: 0 1px 0 0;
  border-radius: 0;
  background: #050505;
  color: $faint;
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ix-mode-strip button.is-active,
.ix-mode-strip button:first-child.is-active,
.ix-mode-strip button:last-child.is-active {
  border-color: $hair;
  background: #111;
  color: $text;
  box-shadow: inset 0 -1px 0 $text;
}
.ix-order > .ix-side-toggle:not(.ix-mode-strip) { gap: 1px; padding: 5px 6px; }
.ix-order > .ix-side-toggle:not(.ix-mode-strip) button {
  min-height: 28px;
  padding: 0;
  border-radius: 0;
  background: #050505;
}
.ix-order .ix-type-tabs {
  flex-wrap: wrap;
  overflow: visible;
  margin: 0;
  border-width: 1px 0;
  border-radius: 0;
}
.ix-order .ix-type-tabs button {
  flex: 1 1 auto;
  min-height: 25px;
  padding: 0 5px;
  font-size: 9px;
  letter-spacing: 0.03em;
}
.ix-order .ix-type-tabs button.is-refused {
  color: $faint;
  border-style: dashed;
}
.ix-order .ix-type-tabs button.is-refused.is-active {
  color: $text !important;
}
.ix-order-body { padding: 7px 8px; }
.ix-field { margin-bottom: 7px; }
.ix-input input { height: 30px; min-height: 30px; }
.ix-unit { height: 30px; line-height: 30px; }
.ix-submit { min-height: 44px; padding: 0 8px; border-radius: 0; box-shadow: none !important; }
.ix-order-note { margin-top: 5px; font-size: 10px; line-height: 1.25; }
.ix-ticket-more-toggle {
  width: 100%;
  border: 0;
  border-top: 1px solid var(--ix-border);
  border-bottom: 1px solid var(--ix-border);
  background: transparent;
  color: var(--ix-dim);
  font: inherit;
  font-size: 11px;
  line-height: 24px;
  text-align: left;
  cursor: pointer;
}
.ix-ticket-more-toggle span { float: right; color: var(--ix-text); }
.ix-ticket-more {
  display: flex;
  gap: 10px;
  padding: 7px 0;
  color: var(--ix-dim);
  font-size: 11px;
}
.ix-ticket-more label { display: inline-flex; align-items: center; gap: 4px; }
.ix-ticket-door-refusal { margin: 0 0 7px; }
.ix-ticket-capability-fields { padding-top: 7px; border-top: 1px solid var(--ix-border); }
.ix-ticket-check { justify-content: flex-start; }
.ix-ticket-check input { width: 24px; min-width: 24px; }
.ix-terminal .ix-tabs button.is-active,
.ix-terminal .ix-type-tabs button.is-active {
  background: #111 !important;
  color: $text !important;
  box-shadow: inset 0 -1px 0 $text;
}
.ix-order-note.ix-kbd-hint {
  display: block;
  font-size: 11px;
}

@media (min-width: 1510px) {
  .ix-body {
    grid-template-columns: var(--ix-market-column-width, 200px) minmax(0, 1fr) var(--ix-right-column-width, 300px) !important;
  }
}
@media (max-width: 1180px) {
  .ix-chart-panel > .ix-tabs { overflow-x: auto; overflow-y: hidden; }
  .ix-chart-panel .ix-intervals,
  .ix-chart-panel .ix-layout-reset { flex: 0 0 auto; }
}
@media (max-width: 1180px) and (min-width: 701px) {
  .ix-body { grid-template-columns: minmax(0, 1fr) 300px !important; }
  .ix-markets { display: none !important; }
  .ix-markets.is-open {
    display: flex !important;
    position: fixed;
    top: 72px;
    bottom: 16px;
    left: 16px;
    z-index: 80;
    width: min(320px, calc(100vw - 32px));
    height: auto;
    border-color: rgba(200, 200, 200, 0.45);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.72);
  }
}
@media (max-width: 700px) {
  .ix-terminal {
    --head-h: 62px !important;
    --col-h: auto !important;
    overflow: visible;
  }
  .ix-head {
    position: relative;
    min-height: 62px !important;
    height: 62px !important;
    padding: 0 7px !important;
    overflow: hidden;
  }
  .ix-desk-brand { display: none; }
  .ix-head .ix-stat { display: none; }
  .ix-head-pair,
  .ix-head-last,
  .ix-head-status { padding: 0 6px; border-right: 1px solid $hair; }
  .ix-head-status {
    flex: 1 1 0;
    min-width: 0;
    margin-left: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: 9px;
  }
  .ix-desk-plane { margin-left: auto; }
  .ix-desk-plane a { min-width: 31px; padding: 0 4px; }
  .ix-desk-plane a:not(.is-active),
  .ix-desk-account { display: none; }
  .ix-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) !important;
    grid-template-rows: auto;
    grid-template-areas: none;
    height: auto !important;
  }
  .ix-markets { display: none !important; }
  .ix-markets.is-open {
    display: flex !important;
    position: fixed;
    top: 72px;
    bottom: 16px;
    left: 16px;
    z-index: 80;
    width: min(320px, calc(100vw - 32px));
    height: auto;
    border-color: rgba(200, 200, 200, 0.45);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.72);
  }
  .ix-centre { display: contents; }
  .ix-chart-panel { order: 1; height: 260px; min-height: 260px; }
  .ix-chart-panel > .ix-tabs,
  .ix-account > .ix-tabs {
    width: 100%;
    box-sizing: border-box;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .ix-chart-panel .ix-intervals { flex: 0 0 auto; }
  .ix-chart-panel .ix-study-toggle {
    min-height: 26px;
    margin: 2px 1px;
    border: 1px solid $hair;
    border-radius: 3px;
  }
  .ix-order-note.ix-kbd-hint { display: none; }
  .ix-rail {
    order: 2;
    display: flex !important;
    grid-area: auto;
    height: 190px;
    min-height: 190px;
  }
  .ix-order { order: 3; grid-area: auto; }
  .ix-account { order: 4; height: 180px; min-height: 180px; }
  .ix-mode-strip { overflow: visible; }
  .ix-mode-strip button { flex: 1 1 20%; padding: 0 3px; }
  .ix-order .ix-type-tabs { flex-wrap: wrap; overflow: visible; }
  .ix-order .ix-type-tabs button { flex: 1 1 auto; }
}

/* remaining-SOT §12.3 / §18.2 desk touch alternatives.
   Finger can act without hover. Book rows keep the 24px floor (#3993).
   Submit/cancel stay ≥44px (#7613122bf). No heatmap. No new types. */
.ix-pair-switch,
.ix-lock-toggle,
.ix-order .ix-type-tabs button,
.ix-book-row,
.ix-market-row {
  box-sizing: border-box;
}
.ix-pair-switch {
  min-height: 24px;
  min-width: 24px;
}
.ix-lock-toggle {
  min-height: 24px;
  min-width: 24px;
}
.ix-order .ix-type-tabs button {
  min-width: 24px;
  min-height: 24px;
}
.ix-book-row {
  min-height: var(--row);
}
.ix-star {
  min-width: 24px;
  min-height: 24px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ix-tabs button:active,
.ix-tabs button:focus-visible,
.ix-order .ix-type-tabs button:active,
.ix-order .ix-type-tabs button:focus-visible {
  color: $text;
  outline: none;
}
.ix-book-row:active,
.ix-book-row:focus-visible {
  background: rgba(255, 255, 255, 0.05);
  outline: none;
}
.ix-market-row:active,
.ix-market-row:focus-visible {
  background: rgba(255, 255, 255, 0.045);
  color: $text;
  outline: none;
}
.ix-lock-toggle:active,
.ix-lock-toggle:focus-visible,
.ix-pair-switch:active {
  border-color: $hair;
  background: var(--ix-surface-raised, #161a22);
  outline: none;
}

@media (max-width: 700px) {
  /* 390 desk composition: keep the pair and channel authority on one honest
     row instead of vertically centring a wrapped 248px chip stack behind the
     clipped header. The chip rail remains touch-scrollable. */
  .ix-head {
    min-height: 48px !important;
    height: 48px !important;
  }
  .ix-head-last { display: none; }
  .ix-head-status {
    align-self: center;
    flex-wrap: nowrap;
    gap: 2px;
    min-height: 32px;
    height: 32px;
    max-height: 32px;
    padding: 0 4px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .ix-head-status::-webkit-scrollbar { display: none; }
  .ix-channel-chip { flex: 0 0 auto; }
  .ix-desk-banner {
    min-height: 32px;
    padding: 2px 8px;
  }

  /* Keep the compact book/tape glance without reserving a desktop-like blank
     tail. Row height remains governed by --row (24px minimum). */
  .ix-rail {
    height: 160px;
    min-height: 160px;
  }

  /* The existing ticket capabilities stay mounted and reachable; at 390 they
     form one touch-scrollable strip instead of three wrapped rows. */
  .ix-order .ix-type-tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }
  .ix-order .ix-type-tabs button { flex: 0 0 auto; }

  .ix-pair-switch {
    min-height: 32px;
    padding: 6px 8px;
  }
  .ix-lock-toggle {
    min-height: 28px;
  }
  .ix-order .ix-type-tabs button {
    min-width: 24px;
    min-height: 28px;
  }
  .ix-market-drawer-close {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    top: 6px;
    right: 6px;
  }
}

/* Ticket selectors describe existing field doors, never execution readiness. */
.ix-order .ix-type-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: visible;
  border: 0;
}
.ix-order .ix-type-tabs .ix-ticket-strip-label {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
  padding: 5px 8px;
  color: #929292;
  font-size: 9px;
  letter-spacing: .08em;
  text-transform: uppercase;
  border-top: 1px solid #282828;
  border-bottom: 1px solid #202020;
}
.ix-ticket-strip-label em { font: inherit; letter-spacing: 0; text-transform: none; }
.ix-order .ix-type-tabs button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  min-height: 34px;
  padding: 6px 8px;
  color: #c8c8c8;
  font-size: 10px;
  line-height: 1.2;
  letter-spacing: 0;
  text-transform: none;
  border-right: 1px solid #202020;
  border-bottom: 1px solid #202020;
}
.ix-order .ix-type-tabs button:focus-visible { outline: 2px solid var(--ix-orange); outline-offset: -2px; }
.ix-order .ix-type-tabs button:disabled { opacity: 1; color: #929292; background: #0b0b0b; cursor: not-allowed; }
.ix-order .ix-type-tabs button.is-refused { border-style: dashed; color: #929292; }
.ix-order .ix-type-tabs .ix-capability-state { color: #929292; font-size: 8px; letter-spacing: .06em; text-transform: uppercase; }
.ix-ticket-strip-note { margin: 0; padding: 7px 8px; color: #929292; font-size: 10px; line-height: 1.4; border-bottom: 1px solid #282828; }
</style>

<!-- Unscoped: the chart host #ix_kline must keep a definite height;
     so it never carries this component's scope attribute. Kept to a single id
     selector so it cannot leak into anything else. -->
<style lang="scss">
#ix_kline iframe {
  display: block;
  width: 100% !important;
  height: 100% !important;
  border: 0;
  background: var(--ix-bg, #000000);
}

/* Protocol-ticket controls are DOM-installed by the existing wire adapters,
   so this disclosure rule must remain unscoped. */
.ix-order-body:not(.is-more-open) #ix-ticket-expire-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-reduce-only-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-oco-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-close-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-post-only-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-ioc-note,
.ix-order-body:not(.is-more-open) #ix-ticket-fok-note,
.ix-order-body:not(.is-more-open) #ix-ticket-iceberg-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-min-qty-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-aon-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-peg-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-auction-wrap,
.ix-order-body:not(.is-more-open) #ix-ticket-self-trade-note,
.ix-order-body:not(.is-more-open) #ix-ticket-stop-limit-wrap {
  display: none !important;
}

/* A selected type-strip capability reveals only its real helper fields. The
   ordinary More disclosure keeps its existing multi-option behavior. */
.ix-order-body.is-capability-selected #ix-ticket-expire-wrap,
.ix-order-body.is-capability-selected #ix-ticket-oco-wrap,
.ix-order-body.is-capability-selected #ix-ticket-close-wrap,
.ix-order-body.is-capability-selected #ix-ticket-iceberg-wrap,
.ix-order-body.is-capability-selected #ix-ticket-aon-wrap,
.ix-order-body.is-capability-selected #ix-ticket-peg-wrap,
.ix-order-body.is-capability-selected #ix-ticket-bracket-wrap,
.ix-order-body.is-capability-selected #ix-ticket-collar-wrap {
  display: none !important;
}
.ix-order-body.is-capability-gtd #ix-ticket-expire-wrap,
.ix-order-body.is-capability-oco #ix-ticket-oco-wrap,
.ix-order-body.is-capability-close #ix-ticket-close-wrap,
.ix-order-body.is-capability-iceberg #ix-ticket-iceberg-wrap,
.ix-order-body.is-capability-aon #ix-ticket-aon-wrap,
.ix-order-body.is-capability-bracket #ix-ticket-bracket-wrap,
.ix-order-body.is-capability-collar #ix-ticket-collar-wrap {
  display: block !important;
}

.ix-kbd-hint {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.35;
  opacity: 0.72;
}
@media (max-width: 700px) {
  .ix-kbd-hint { display: none; }
}
.ix-kbd-hint kbd {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--ix-hairline, #242a34);
  border-radius: 4px;
  font-size: 10px;
  font-family: inherit;
  color: var(--ix-text-dim, #8a909c);
  background: var(--ix-surface-raised, #161a22);
}
.ix-blotter-tools {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: 0 0 8px;
}
.ix-linkish {
  background: transparent;
  border: 0;
  color: var(--ix-orange, #c8c8c8);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 0 4px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.ix-linkish:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  text-decoration: none;
}
.ix-mass-cancel {
  appearance: none;
  border: 1px solid var(--ix-hairline, #202020);
  border-radius: 0;
  min-height: 44px;
  padding: 0 12px;
  background: #0b0b0b;
  color: var(--ix-text-dim, #8a8a8a);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  box-shadow: none;
}
.ix-mass-cancel:hover:not(:disabled) {
  background: #111;
  color: var(--ix-text, #c8c8c8);
}
.ix-mass-cancel:disabled {
  background: #111;
  color: #6a6a6a;
  cursor: not-allowed;
}
.ix-mass-cancel-all {
  border-color: var(--ix-hairline, #202020);
  background: #0b0b0b;
  color: var(--ix-text-dim, #8a8a8a);
}
.ix-actions {
  white-space: nowrap;
}
.ix-actions .ix-cancel {
  margin-left: 8px;
}
/* B6 watchlist rail */
.ix-watch-rail {
  border-bottom: 1px solid var(--ix-hairline, #242a34);
  margin-bottom: 1px;
  padding-bottom: 1px;
}
.ix-watch-rail-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
  padding: 0 7px;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ix-text-dim, #8a909c);
}
.ix-market-row-watch {
  background: rgba(200, 200, 200, 0.04);
}
/* B10 screen-reader only */
.ix-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
/* B2 density — pair head + stats tighter */
.ix-terminal .ix-head {
  min-height: 44px;
}
.ix-terminal .ix-stat dt {
  font-size: 10px;
}
.ix-terminal .ix-stat dd {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ix-terminal .ix-order .ix-meta {
  font-size: 12px;
}
.ix-order-note.ix-order-error:focus {
  outline: 1px solid var(--ix-orange, #c8c8c8);
  outline-offset: 2px;
}
/* A-UI-A11Y — local fallback if intafaced.css load order lags */
.ix-terminal .ix-error-summary {
  margin-bottom: 10px;
}
.ix-terminal .ix-error-summary:focus {
  outline: 2px solid var(--ix-orange, #c8c8c8);
  outline-offset: 2px;
}
.ix-outcome-banner {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 9px;
  border: 1px solid rgba(189, 189, 189, 0.55);
  border-radius: 4px;
  background: rgba(189, 189, 189, 0.1);
  color: #d8d8d8;
  font-size: 11px;
}
.ix-outcome-banner strong,
.ix-outcome-unknown {
  color: #d8d8d8;
}
.ix-batch-box {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.ix-batch-lead {
  margin-top: 0;
}
.ix-batch-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.ix-batch-actions .ix-submit {
  padding: 8px 4px;
  font-size: 11px;
}
.ix-batch-list,
.ix-batch-results {
  max-height: 150px;
  margin: 8px 0 0;
  padding-left: 18px;
  overflow: auto;
  color: var(--ix-text-faint, #6b6b6b);
  font-size: 10px;
}
.ix-batch-list li,
.ix-batch-results li {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-height: 20px;
}
.ix-batch-list code,
.ix-batch-results code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ix-batch-list .ix-linkish {
  margin-left: auto;
}

/* The compact markets panel is a fixed drawer. Keep this final so the desk
   composition's !important hidden rules cannot override the explicit open
   state at tablet or phone widths. */
@media (max-width: 1180px) {
  .ix-markets.is-open {
    display: flex !important;
    grid-area: auto;
    max-width: calc(100vw - 32px);
    overflow: hidden;
  }
}
</style>
