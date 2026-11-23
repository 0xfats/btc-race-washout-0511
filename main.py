"""Dislocation-only cbBTC race bot for make.fun btc-race-24h-20261123-0511.

Strategy (validated offline on the kit dev window, then with the kit grader):
  * Wait for a real washout: the 15-minute close-to-close return at or below -0.8%,
    confirmed by two consecutive up closes (the bounce has started).
  * Buy once, full size (all cash), at most 2 round trips in the whole 24h window.
  * Sell the whole position at +2.0% from the entry close, or on a -0.3% stop
    from the entry close, or on a -0.4% pullback from the peak close since entry.
  * Otherwise hold cash and do nothing. No shorts, no leverage, no trend chasing.

Why this shape: on the 18 Nov race the winners made exactly 2 trades, buying the
one washout and selling the rebound, then stopping. A busy mean-reversion bot
fires on every dip and chops itself up on fees (a full round trip costs ~26 bps).
This bot only fires on an extreme 15-minute dislocation with a confirmed bounce,
so in a quiet window it may trade once, twice, or not at all -- and that is fine:
one good washout trade beats ten chopped ones.

Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
One reply per batch, echoing its seq. Orders decided on a batch fill at the next
bar's open. Deterministic: every decision is a pure function of the bars seen so
far. No clock, no environment, no randomness, no network, no files.
"""

import json
import sys

SYMBOL = "CBBTC"

# --- strategy parameters (tuned offline on the dev window, see notes above) ---
DIP_WINDOW_BARS = 15        # look-back for the dislocation, in 1-minute bars
DIP_THRESHOLD = -0.008      # 15-min return at or below -0.8% counts as a washout
CONFIRM_UPTICKS = 2         # consecutive up closes confirming the bounce
TAKE_PROFIT = 0.020         # sell at +2.0% from the entry close
STOP_LOSS = -0.003          # sell at -0.3% from the entry close
TRAIL_PULLBACK = -0.004     # sell on a -0.4% pullback from the peak since entry
MAX_ROUND_TRIPS = 2         # at most this many buys in the whole window
MAX_SLIPPAGE_BPS = 100      # 1%: far above any fill move seen on the dev window


class Bot:
    """Keeps the account and the bar history; answers one batch at a time."""

    def __init__(self, hello):
        self.hello = hello
        capital = hello["capital"]
        self.quote_scale = int(capital["quote_scale"])
        self.cash = int(capital["quote_units"])
        symbol_info = {s["symbol"]: s for s in hello["symbols"]}[SYMBOL]
        self.price_scale = int(symbol_info["price_scale"])
        self.qty_scale = int(symbol_info["qty_scale"])
        self.warmup_bars = int(hello.get("warmup_bars", 0))
        self.closes = []            # closes in USD, one per bar seen
        self.qty = 0                # held quantity, in qty-scale units
        self.entry_close = None     # close of the bar the buy was decided on
        self.peak_close = None      # highest close since the entry
        self.buys_done = 0          # round trips started
        self.next_client = 1

    def _client_id(self):
        cid = "o%d" % self.next_client
        self.next_client += 1
        return cid

    def _price_usd(self, raw_str):
        return int(raw_str) / (10 ** self.price_scale)

    def apply_account(self, account):
        self.cash = int(account["cash_quote_units"])
        held = 0
        for pos in account.get("positions", []):
            if pos["symbol"] == SYMBOL:
                held = int(pos["qty"])
        self.qty = held
        if held == 0:
            self.entry_close = None
            self.peak_close = None

    def decide(self, seq):
        """Return the orders for this batch (possibly none)."""
        if seq < self.warmup_bars:
            return []
        if not self.closes:
            return []
        close = self.closes[-1]

        if self.qty > 0:
            # Holding: manage the exit.
            if self.peak_close is None or close > self.peak_close:
                self.peak_close = close
            gain = close / self.entry_close - 1.0
            if gain >= TAKE_PROFIT:
                return [self._sell_all()]
            if gain <= STOP_LOSS:
                return [self._sell_all()]
            if close / self.peak_close - 1.0 <= TRAIL_PULLBACK:
                return [self._sell_all()]
            return []

        # Flat: only a confirmed washout buys, and only twice per window.
        if self.buys_done >= MAX_ROUND_TRIPS:
            return []
        if self.cash < 10 ** self.quote_scale:  # under $1: below min notional
            return []
        n = len(self.closes)
        if n <= DIP_WINDOW_BARS + CONFIRM_UPTICKS:
            return []
        dip = close / self.closes[-1 - DIP_WINDOW_BARS] - 1.0
        if dip > DIP_THRESHOLD:
            return []
        for j in range(CONFIRM_UPTICKS):
            if self.closes[-1 - j] <= self.closes[-2 - j]:
                return []
        self.buys_done += 1
        self.entry_close = close
        self.peak_close = close
        return [{
            "side": "buy",
            "client_id": self._client_id(),
            "symbol": SYMBOL,
            "notional_quote_units": str(self.cash),
            "max_slippage_bps": MAX_SLIPPAGE_BPS,
        }]

    def _sell_all(self):
        return {
            "side": "sell",
            "client_id": self._client_id(),
            "symbol": SYMBOL,
            "qty": str(self.qty),
            "max_slippage_bps": MAX_SLIPPAGE_BPS,
        }


def main():
    bot = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            if msg.get("protocol") != "agent-fun/bars-replay/v1":
                raise SystemExit("unsupported protocol: %r" % (msg.get("protocol"),))
            bot = Bot(msg)
        elif kind == "batch":
            if bot is None:
                raise SystemExit("batch before hello")
            for bar in msg.get("bars", []):
                if bar.get("symbol") == SYMBOL:
                    bot.closes.append(bot._price_usd(bar["c"]))
            bot.apply_account(msg["account"])
            orders = bot.decide(int(msg["seq"]))
            out.write(json.dumps(
                {"type": "reply", "seq": int(msg["seq"]), "orders": orders},
                separators=(",", ":"),
            ) + "\n")
            out.flush()
        elif kind == "done":
            if bot is None:
                raise SystemExit("done before hello")
            bot.apply_account(msg["account"])
            return
        else:
            raise SystemExit("unknown message type: %r" % (kind,))
    raise SystemExit("input ended before done")


if __name__ == "__main__":
    main()
