# Ads Guard

Open `/dashboard/ads` from the dashboard sidebar. Use **Try example report** to explore six fictional cases without connecting an ad account.

## Connect real reporting

1. Enable the Marketing API product for the existing Meta app. Obtain the access level and app review required for the users and ad accounts you intend to serve. Development access is limited to the app's permitted test users/accounts.
2. Select **Connect ad access**. The OAuth flow requests the existing Page permissions plus `ads_read`. Ordinary Page sign-ins keep their existing scopes. The Facebook user must have reporting access to the paying ad account; a shared Page token does not grant advertising access.
3. Choose the account and optionally a connected Facebook Page. Ads are matched through creative Page identity or post identity. Ads without a known Page remain visible under **All account ads**.
4. Choose conversations, leads, or purchases and configure an affordable target CPA in the account's currency. For purchase scaling, also set minimum ROAS and ensure Meta reports purchase values.

This first version only reads advertising data. It does not request `ads_management`, pause ads, alter budgets, or continuously monitor accounts. Ads Manager links let the user review and implement a recommendation. There is no database migration or new secret required. Settings are saved locally per signed-in user, account, and goal; they are not shared across devices or team members.

## Reporting and rules

Reports compare seven completed days with the preceding seven in the account timezone and retrieve 28 days of daily history. Each ad set's unified attribution setting is used consistently, with results reported against impression dates. Weekly reach/frequency come directly from the full-period response. Daily reach is never summed. Overlapping conversion-event aliases are not added together. Started Messenger conversations are not substituted with new messaging connections.

Newest completed days are excluded from decisive CPA rules according to the configured attribution delay (default two). Launches and recent edits to the ad, ad set, or campaign are held for additional settled delivery. Delivery status is checked before performance advice. Results are Meta-reported attribution, not verified sales or lead quality.

- **Pause review:** settled spend exceeds the configured stop-loss multiple (default 3× target CPA), the account-wide false-discovery-adjusted screening score is below 5%, the modeled probability of meeting target is below 5%, and there are zero settled results or settled CPA is at least 50% above target.
- **Refresh creative:** both windows have enough selected results and at least 1,000 impressions; weekly frequency exceeds its threshold, CTR falls, and CPA rises. Frequency alone never establishes fatigue.
- **Reduce / investigate:** settled CPA is above target, costs rose beyond the configured threshold in comparable windows, or purchase ROAS misses its target. Suggestions distinguish CPM increases, CTR declines, and conversion-path friction.
- **Scale review:** settled CPA is at least 20% below target, modeled target probability is at least 97.5%, both weeks are comparable, and recent settled delivery remains efficient. Day-to-day overdispersion must stay below 1.5. The complete reported shared budget must also have at least a 90% modeled probability of meeting target. Learning/learning-limited ads and unknown budget owners do not qualify. Purchases need reported ROAS at least 20% above the configured minimum. A suggested 10% increase remains conditional on reviewing the budget's other objectives and ads in Ads Manager.
- **Gather data / hold:** insufficient settled results, fresh edits, absent delivery, or good performance without enough evidence to scale.

The Gamma/Poisson posterior provides a modeled target probability and a 90% CPA interval. Its weak empirical prior contributes one pseudo-result at a bounded, leave-one-out median peer rate. Day-level Pearson overdispersion discounts both counts and spend to widen uncertainty for clustered conversions. Matched settled weekdays from the previous week are compared through deterministic posterior integration to estimate meaningful cost increases. Large-count Gamma probabilities use the Wilson–Hilferty approximation.

The Benjamini–Hochberg correction runs across eligible account ads before Page filtering. Shared budgets are also evaluated before Page filtering, including sibling ads on other Pages. These are adjustable screening models, not calibrated guarantees, controlled experiments, or causal attribution. Auction changes, dependent tests, view-through conversions, mixed objectives, and conversion tracking gaps can violate the assumptions. Evidence labels describe data availability and rule agreement. Verify tracking and actual sales quality before acting.

Complete cursor pagination is required. Permission failures, throttling, timeouts, malformed data, pagination failures, oversized reports, and daily/weekly spend mismatches withhold the report instead of creating decisions from partial data. Large accounts require a future asynchronous/background reporting implementation.

Future continuous monitoring should use durable per-account settings, scheduled reporting, stored history, alert delivery, attribution backfills, and a separate opt-in workflow for advertising changes.

## References

- [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/)
- [Meta Insights API](https://developers.facebook.com/docs/marketing-api/insights/)
- [Meta's official SDK: ad account reporting parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py)
- [Meta's official SDK: creative Page identity](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py)
