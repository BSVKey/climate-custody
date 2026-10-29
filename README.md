# Climate Custody

Proof of measurement for climate money.

A carbon credit, a methane reduction or a renewable energy certificate is a claim that a
measured quantity happened. Much of the trouble in these markets comes from measurements nobody
can check later: readings edited or filled in after the fact, meters out of calibration, gaps
quietly papered over, a verifier's sign-off on one version of a claim attached to another, and
the same tonne sold twice.

Here the meter (or its gateway) signs each window of readings when the window closes, as one
Merkle root over every reading. A calibration lab signs each certificate. The developer signs the
claim, naming the windows it rests on and the calculation method. Anyone given the readings can
re-derive the claimed tonnes and see exactly where they differ. The verifier signs one exact claim
version. Registries sign issuance and retirement serial ranges, so a tonne issued twice, retired
twice or issued beyond what was measured shows up.

```
npm test          # offline, zero dependencies
node demo.mjs     # a sample landfill-gas flare over 30 days, then issuance and retirement
```

## What the demo shows

```
Sample landfill flare, 2026-09-01 to 2026-09-30: 30 daily windows, 2856 signed readings
Developer claims 3,626.5 t CO2e
Re-derived from the signed readings: 3,121.1 t CO2e (505.4 t over-claimed)
  2026-09-08    91.6 t  24 readings missing (gap recorded by gateway)
  2026-09-13   107.5 t  12 readings with the flare out, no destruction credited
  2026-09-19       0 t  signed 72 h after the window closed: BACK-FILLED, not credited
  2026-09-25       0 t  96 readings outside any calibration certificate, not credited
  ...
Corrected claim 3,121.1 t re-derives: PASS (no over-claim)
Verifier signed version 2 of 3; latest version verified: false; revised after verification: true (+187.3 t)

A buyer checks one reading against the meter's signed root: true
  the same reading with flow raised 10%: false

Tamper and double-counting cases:
  one reading's flow doubled after the meter signed          CAUGHT: readings_do_not_match_signed_root, ...
  meter key revoked on 21 Sep (stolen), windows after it     CAUGHT: window_key_revoked, ...
  window signed by a different device's key                  CAUGHT: window_signer_not_registered_key, ...
  same windows sold again under a second project             CAUGHT: window_counted_twice
  same claim issued at a second registry                     CAUGHT: issued_at_two_registries, ...
  serials 401-500 retired for two different buyers           CAUGHT: retired_twice
  registry issues 400 more credits than were measured        CAUGHT: issued_more_than_measured
  issuance record forged in a registry's name                CAUGHT: issuance_signer_not_pinned_key
```

All names, numbers and keys are sample data. The calculation (`illustrative-lfg/1`) is a
simplified landfill-gas flare formula for the demo, not a registry methodology; real
methodologies plug in as named methods in `src/verify.mjs`.

## Records

| Record | Signed by | Says |
|---|---|---|
| `climate.window/1` | the device key | one root over every reading in a window, count vs expected, when it was signed; chained per device |
| `climate.calibration/1` | calibration lab | device, certificate, valid from and to |
| `climate.gap/1` | gateway or witness | an expected stretch of readings did not arrive, and why |
| `climate.claim/1` | project developer | tonnes claimed for a vintage, the windows, the method and its parameters |
| `climate.verification/1` | third-party verifier | an opinion on one exact claim version |
| `climate.issuance/1` | registry | a serial range issued against one claim |
| `climate.retirement/1` | registry | a serial range retired for a named beneficiary |

Readings are integers (CH4 in basis points, flow in litres, temperature in whole degrees) so the
re-derivation is exact. Each leaf is salted, so a buyer can be shown one reading without the
proof revealing its neighbours. The default rules are conservative and each one is a parameter:
a window signed more than 2 hours after it closed earns nothing; readings outside a calibration
certificate earn nothing; missing readings earn nothing and must be explained by a signed gap
record.

## What this can and cannot fix

It can show that the numbers under a credit were fixed when they were measured, by a known
device, under a valid calibration, using the stated formula, and that each tonne was issued and
retired once across the registries whose records are checked.

It cannot make the underlying choices honest. Most disputes over climate credits are about
judgement, not arithmetic:

- **Baseline and additionality.** What would have happened anyway is a counterfactual. A
  perfectly measured flare can still earn credits it should not if the gas would have been
  burned regardless. Avoided-deforestation credits rest almost entirely on such baselines.
- **Permanence and leakage.** Whether stored carbon stays stored, and whether the activity just
  moved elsewhere, happen outside the meter.
- **Who chooses and pays the verifier.** When the developer pays the auditor, a signed opinion
  shows who signed what, not that the incentives were sound.
- **Physical tampering.** Signed data is tamper-evident, not tamper-proof: a bypass pipe around
  a flow meter produces honestly signed wrong numbers. Site inspection, independent sensors and
  satellite cross-checks still matter.
- **Counting across countries.** The double-counting checks cover the issuance and retirement
  records given to them, not national inventories or claims made outside those registries.

So the useful claim is narrow: this removes the excuses about the data, so the arguments that
remain are the real ones.

## Fits best

Credits where the quantity is metered, not modelled: methane destruction (landfill, coal mine,
oil and gas flaring), metered renewable energy, metered storage for removals, sensor-equipped
cookstoves. Physical samples (soil cores, biochar batches) would add a chain-of-custody record
like the BSVKey pharma core; not built here.

## Hourly energy certificates

`src/granular.mjs` checks hourly (granular) clean-energy certificates against a meter's signed
readings. Hourly certificate registries, such as EnergyTag-style Granular Certificates (for
example the open-source Future Energy Associates registry) and Energinet's Project Origin,
issue certificates from metered production, but take the meter data on trust: an uploaded file
or the issuing body's word. Here the meter signs each window of 15-minute Wh readings when it
closes (`climate.window/1`, salted Merkle root, chained), and anyone holding the readings can
check every certificate:

- more energy certified for a device and hour than the signed meter recorded
- certificate ids issued twice, or a bundle whose id range does not match its quantity
- an hour certified with no signed meter data behind it
- meter data back-filled (signed long after the hour), edited after signing, signed by an
  unregistered key, missing without a signed gap record, or with a broken window chain

```
node granular-demo.mjs
```

```
hour (UTC)  certified kWh  metered kWh  status
11:00         4,862.9      4,502.7  over_issued       issued from a forecast, +8%
16:00         3,092.1            0  not_metered       meter data signed 17 h late
21:00             150            0  not_metered       no meter data at all
Certified 37,389.8 kWh; supported by signed meter data 33,394.4 kWh; unsupported 3,995.3 kWh
```

Adapters: `fromEnergyTagBundle` reads a GranularCertificateBundle (`face_value` Wh x
`bundle_quantity`, id range, production interval); `fromProjectOriginIssued` reads a Project
Origin `IssuedEvent` with the quantity from its commitment opening, which the auditor must be
given. That adapter does not check the opening against the commitment; that needs Project
Origin's own library. Withdrawn certificates are ignored; claimed (Cancelled) ones still count.
One 15-minute reading can be proven to a buyer without showing the rest of the day.

## Production notes

The demo signs with Ed25519 via `node:crypto` so it runs with zero dependencies. Production signs
with the compact Bitcoin Signed Message envelope used across BSVKey; the content-addressing route
is identical. Window roots can be anchored on Bitcoin BSV so the time a window was fixed does not
rest on the signer's own clock. Public reference data (weather, satellite products) is witnessed
with the method in [BSVKey/wx-custody](https://github.com/BSVKey/wx-custody).

## License

Apache-2.0. Evidence only: this software records and checks what parties signed. It does not
issue, rate, verify or trade credits, and is not affiliated with any registry or standard.
