# Android signing

Release builds use channel-specific signing files that are intentionally not
tracked by Git:

- `main.properties` and `main-release.jks` sign the `main` app.
- `dev.properties` and `dev-release.jks` sign the `dev` app.

Back up both keystores and their properties securely. Losing a keystore makes
future APKs unable to update apps signed by that key.

The channel is detected from the current Git branch. CI or detached checkouts
must set `APP_CHANNEL` to `main` or `dev` explicitly.

GitHub Actions restores the same files from these repository secrets:

| Channel | Required secrets |
| --- | --- |
| `main` | `MAIN_KEYSTORE_BASE64`, `MAIN_STORE_PASSWORD`, `MAIN_KEY_ALIAS`, `MAIN_KEY_PASSWORD` |
| `dev` | `DEV_KEYSTORE_BASE64`, `DEV_STORE_PASSWORD`, `DEV_KEY_ALIAS`, `DEV_KEY_PASSWORD` |

`*_KEYSTORE_BASE64` must contain the Base64 encoding of the matching JKS file.
