# Machine-readable specs

The same routes as files a program reads: an OpenAPI 3 description, a request collection and an index of these pages for assistants. Each lists the permission, the cost of a call and the refusals.

- Download the OpenAPI file: /developers/openapi.json

- Download the collection: /developers/collection.json

Every call costs 1 from the rate-limit bucket; no route weighs more.

Neither file names a server, because no host is set. The base addresses page shows each host the owner sets.
