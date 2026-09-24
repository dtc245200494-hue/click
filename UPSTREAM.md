# Upstream

Base project studied for this derivative:

- Repository: https://github.com/alexfernandez/loadtest
- Upstream branch: `main`
- Upstream tree inspected: `6db18e0fbcaf64d816d06f65ef0193afda220744`
- Upstream package version at inspection: `8.2.1`
- License: MIT

The request-pool architecture in `lib/requestPool.js` is intentionally based on the upstream `Pool` concept, but changed to enforce a hard concurrency ceiling and to work with scheduled campaign slots.
