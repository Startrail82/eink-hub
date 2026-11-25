# Adding a weather provider

The Hub gets its weather (for the weather source of [AI collections](/guide/ai-images)) through a small interface, so another service can be added without touching the rest of the code. [Open-Meteo](https://open-meteo.com/) is the first provider and the default. The source is chosen under **Settings > Weather**.

## What a provider does

A provider is an object with four fields, defined in `apps/server/src/lib/weather/provider.ts`:

| Field | Meaning |
| --- | --- |
| `id` | Stable name that is saved in the settings, for example `open-meteo`. |
| `name` | Name shown in Settings. |
| `key` | `'none'`, `'optional'` or `'required'`: whether Settings shows a field for an API key. |
| `fetch({ latitude, longitude, apiKey })` | Returns a `WeatherSnapshot`, or throws an `AiError` with a readable message. |

A `WeatherSnapshot` is the same for every provider:

| Field | Meaning |
| --- | --- |
| `code` | WMO weather code (`0` clear, `3` overcast, `63` rain, `95` thunderstorm...). Convert the service's own codes to WMO. |
| `temperature` | Degrees Celsius. |
| `high`, `low` | Today's highest and lowest temperature in degrees Celsius, or `null`. |
| `wind` | Wind speed in km/h, or `null`. |
| `isDay` | Whether it is day at the place right now. |
| `time` | Local time at the place, `YYYY-MM-DDTHH:MM`, without a time zone suffix. |
| `sunrise`, `sunset` | Today's times in the same format, or `null`. |

The placeholders of a prompt (`{condition}`, `{daypart}`, `{temperature}`, `{high}`, `{low}`, `{wind}`, `{sunrise}` and `{sunset}`) are built from this snapshot only, in `apps/server/src/lib/weather/describe.ts`. A provider never has to know about prompts.

## Steps

1. Add `apps/server/src/lib/weather/<name>.ts` that exports a `WeatherProvider`. `openmeteo.ts` is a complete example, including the function that turns the service's answer into a snapshot.
2. Add the provider to the `weatherProviders` list in `apps/server/src/lib/weather/index.ts`. Settings lists it from there, and shows the key field when `key` is not `'none'`.
3. Add tests that turn a sample answer of the service into a snapshot (see `apps/server/test/weather.test.ts`). Do not call the real service in tests.

Keep the provider's key out of logs and error messages. The key is saved on the Hub, never sent back to the browser, and forgotten when another provider is chosen.
