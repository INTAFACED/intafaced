# Errors

Every error the trading REST API (/api/v1) links here: a refused order body, and an order call during the platform posting freeze. Branch on the code; the detail code names the decision behind it.

## Order errors

| Code                   | HTTP status | Detail code                | Cause                                                                                                                                             | What to do                                                            |
| ---------------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `InvalidOrder`         | 400         | `trade.validation_failed`  | The order body has invalid fields. The reply lists each one once under errors, with its field and what is wrong with it.                          | Correct every field the errors list names, then send the order again. |
| `InvalidOrder`         | 400         | `trade.invalid_tag`        | The tag is the only invalid field: it must be 1 to 16 characters.                                                                                 | Send a tag of 1 to 16 characters, or none.                            |
| `OnMaintenance`        | 400         | `posting_frozen`           | Posting is paused platform-wide, and the order was refused before it reached the matching engine: nothing was placed or held. Reads still answer. | Wait, then send the same order with the same client order id.         |
| `ExchangeNotAvailable` | 503         | `trade.settlement_pending` | Posting paused, or its answer was lost, after the matching engine took the order: the order exists and its settlement is not confirmed.           | Read the order by its client order id before sending it again.        |

- Authentication and permission errors: /developers/errors/auth
