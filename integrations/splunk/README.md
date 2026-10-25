# Shield KYA App for Splunk: source and build

`shield_kya/` is the Splunk app source. Its own [README](shield_kya/README.md) is the user guide (install, data inputs, limits). This page is for maintainers.

| Path | What it is |
|---|---|
| `shield_kya/` | The app: `app.conf`, `app.manifest`, `props.conf`, `transforms.conf`, `macros.conf`, the Simple XML dashboard, nav, metadata, icons, README, LICENSE (MIT, MFR Limited) |
| `build.py` | Makes `dist/shield_kya-<version>.tgz` (Python stdlib only) and checks the package rules |
| `appinspect.sh` | Opt-in: builds the package and runs Splunk AppInspect in a container |
| `test/trail-sample.jsonl` | A real trail file from `kya wrap --offline` (six verdicts, temp HOME) |
| `test/hec-span-events.jsonl` | Real HEC event bodies: the OTLP capture from `test/fixtures/otlp-capture.json` sent through OpenTelemetry Collector contrib 0.162.0 with the `splunk_hec` exporter to a local sink |

## Build

```bash
python3 integrations/splunk/build.py            # writes integrations/splunk/dist/shield_kya-<version>.tgz
```

A `.spl` file is the same tar.gz. Do not package the app with macOS `tar`: it adds `._*` files and extended attributes, and Splunkbase refuses them. `build.py` writes one root folder, sorted entries, uid and gid 0, mode 0644 for files and 0755 for folders, and fails on hidden files, a `local/` folder or `.pyc` files.

## Checks

- `pnpm test` runs `test/splunk-app.test.ts` (in CI with the other kya tests). It checks that `app.conf` and `app.manifest` agree, that the span `EVAL`s read only attributes in `otlp-fields.json`, that the trail aliases read only `TrailEvent` keys, that both source types define every `kya_*` field and macro the dashboard uses, and that the `transforms.conf` regexes give the expected values on the two real samples above.
- `bash integrations/splunk/appinspect.sh [out-dir]` (opt-in, needs podman). It runs `splunk-appinspect` 4.3.1 in `python:3.12-slim` twice: default checks and `--included-tags cloud`. It exits 1 on any failure or error. The JSON reports go to the out folder.

Result on 2026-10-20 for version 0.1.0: default checks 99 success, 0 failure, 0 error, 0 warning, 0 skipped. Cloud tag: 95 success, 0 failure, 0 error, 0 warning, 0 skipped. An HEC input stanza (`[http://...]` in `inputs.conf`) fails `check_inputs_conf_for_http_inputs`, so the app has no `inputs.conf`. Users create the HEC token in Splunk Web.

## Not tested

- A live Splunk Enterprise or Splunk Cloud instance. The `splunk/splunk` image is amd64 only. On an arm64 Mac (podman with Rosetta, 2 GiB VM) the 10.4.4 container did not finish its setup in 35 minutes. So the HEC input, the index-time settings of `shield:kya:trail` (line breaking, `TIME_PREFIX`, `TIME_FORMAT`) and the dashboard searches did not run in Splunk. The tests above check the field names and the regexes outside Splunk.
- Splunkbase upload. Splunkbase runs its own package validation, an antivirus scan, AppInspect and Splunk Cloud vetting, then a manual review. The manual review and the cloud vetting can find more than the local AppInspect run.
