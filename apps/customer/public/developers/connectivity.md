# Connectivity

How to reach the API, and how to keep your clock in step with it.

| Option             | Status                                                                          | Endpoints                                    |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Internet           | host not set                                                                    | The production REST, WebSocket and FIX hosts |
| Redundant endpoint | host not set                                                                    | The regional hosts, in failover order        |
| Low-latency path   | Parked: needs hardware we do not own (a physical cross-connect and rack space). | No address is published                      |
| Colocation         | Parked: needs hardware we do not own (a physical cross-connect and rack space). | No address is published                      |

## Time synchronisation

Signed calls carry a timestamp. Keep your clock on a standard network time source and check it here. The check reads GET /api/v1/time and takes the offset at the middle of the round trip. Keep your clock on a standard network time source.
