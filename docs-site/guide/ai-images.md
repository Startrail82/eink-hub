# AI images

An **AI collection** fills itself with pictures drawn by an image generator: a cartoon about today's headline, or anything you can describe in a prompt. The Hub makes each picture shortly before a Canvas changes, so a new one is ready when the Canvas wakes up.

## 1. Connect a generator

Open **Settings > AI images** (admins only). One connection is used by the whole Hub.

Pick the **Service**:

| Service | What it needs |
| --- | --- |
| **Google Gemini** | An API key from [Google AI Studio](https://aistudio.google.com/apikey). |
| **OpenAI** | An API key from [platform.openai.com](https://platform.openai.com/api-keys). |
| **ComfyUI (self-hosted)** | Its address and a workflow, see below. |
| **Another OpenAI-compatible service** | Its address and a model, for anything else that implements `POST /v1/images/generations`, such as LocalAI. |

### Google Gemini and OpenAI

Paste your **API key** and press **Test connection**. The Hub reads the image models of your account, and the **Model** field becomes a list of them. A model is already chosen (`gemini-2.5-flash-image` for Gemini, `gpt-image-1` for OpenAI); pick another one if you prefer, or *Another model…* to type a name the list doesn't show.

The key is stored on the Hub and never shown again. Leave the field empty to keep the saved one. Each picture is charged to your account by Google or OpenAI.

### Another OpenAI-compatible service

| Field | What to enter |
| --- | --- |
| Address | The base address up to and including `/v1`, for example `http://192.168.1.30:8080/v1`. |
| API key | Only if the service asks for one. |
| Model | The model name. **Test connection** lists every model the service offers, as it can't tell which ones draw pictures. |

### Image size

Under **Advanced options**, for Gemini, OpenAI and other compatible services. Leave it empty and the Hub picks a size that matches the Canvas. Enter a size such as `1024x1536` to choose one, or `none` for a service that does not accept a size (xAI's image API is reported to reject it), and no size is sent.

### ComfyUI

| Field | What to enter |
| --- | --- |
| Address | Where ComfyUI runs, for example `http://192.168.1.30:8188`. |
| Username and password | Only when ComfyUI sits behind a login, for example an Authentik proxy. The Hub then signs in with HTTP Basic. With Authentik, use a service account and its app password. Leave empty for a plain ComfyUI. |
| Workflow | Your workflow in **API format** (see below). |

In ComfyUI, build a workflow you are happy with, then use **Save (API Format)** (enable *Dev mode options* in the settings if the entry is missing) and paste the JSON into the Hub. Then put placeholders where the Hub should fill something in:

| Placeholder | Replaced by |
| --- | --- |
| `{{prompt}}` | The prompt, inside any text value, for example the `text` of a `CLIPTextEncode` node. Required. |
| `{{negative}}` | The collection's *Negative prompt* (what the picture should not look like), inside any text value, for example the `text` of the second `CLIPTextEncode` node. Optional: without it, collections have no negative prompt. Empty when the collection has none. |
| `"{{seed}}"` | A random number. Write it as a string; the Hub turns it into a number. |
| `"{{width}}"`, `"{{height}}"` | The size for the Canvas, as numbers (the longest side is at most 1216 pixels). |

**Test connection** checks the address (and your key) without generating a picture.

**Remove configuration** forgets the service, its address and its key. AI collections and their pictures stay, but no new pictures are made until a service is set up again. Until one is, the Library doesn't offer **New AI collection**.

## 2. Create an AI collection

In the **Library**, choose **New AI collection** and pick what to draw:

- **A fixed prompt.** The same description every time. The result still differs from picture to picture.
- **An RSS feed.** Each picture is made from the newest feed item that has not been drawn yet. When all items were drawn, it starts again with the newest. Leave the prompt empty for a cartoon of the headline, or write your own with `{title}` and `{description}`. RSS 2.0 and Atom feeds are supported.

### Placeholders

A prompt can contain placeholders. Each time a picture is made, the Hub replaces them with their current value. In the collection's settings, click one to add it to the prompt where the cursor is.

| Placeholder | Replaced by | Example |
| --- | --- | --- |
| `{date}` | The day, in English | `Friday 27 November 2026` |
| `{time}` | The nearest full hour, in the Hub's time zone. A picture is made shortly before the Canvas changes, so this is about the time it goes on screen. | `14:00` |
| `{season}` | The season, in English. For now it follows the northern hemisphere. | `winter`, `spring`, `summer`, `autumn` |
| `{condition}` | The weather, the way a picture can show it (see below) | `steady rain, rain streaks falling` |
| `{daypart}` | The light at the hour of the picture | `sunset, warm glowing sky` |
| `{temperature}`, `{high}`, `{low}`, `{wind}` | Degrees Celsius and km/h, rounded | `12` |
| `{sunrise}`, `{sunset}` | That day's times at the location | `07:52` |
| `{title}` | RSS only: the headline of the feed item | |
| `{description}` | RSS only: the summary of the feed item, up to 500 characters | |

An unknown placeholder (a typo, say) is left out rather than sent to the generator as is. For example, `A watercolour of a quiet street on a {season} {date}, around {time}` becomes "A watercolour of a quiet street on a winter Friday 27 November 2026, around 14:00".

Choose the **Screen type** and **orientation** the pictures are made for. They are generated at that screen's shape, so they fit without cropping. When you later use the collection on a Canvas with a different resolution or orientation, the Hub warns you that the pictures will be cropped or scaled.

### The weather in a prompt

Any prompt can use the weather. Add one of these placeholders and the Hub fetches the weather for the location of the first Canvas that shows the collection (its own location, or else the hub's under **Settings > Location**), using the source chosen under [Settings > Weather](/guide/weather):

- `{condition}`: the weather the way a picture can show it, for example `steady rain, rain streaks falling, wet glistening ground with puddle reflections`, `snowfall, snowflakes drifting through the air, snow-covered ground` or, by night, `clear sky with a bright moon and stars`.
- `{daypart}`: `night time, dark night`, `sunrise, soft golden light on the horizon` (within 45 minutes of sunrise), `day time` or `sunset, warm glowing sky` (within 45 minutes of sunset), for the hour of the picture.
- `{temperature}`, `{high}`, `{low}` and `{wind}`: degrees Celsius and km/h, rounded.
- `{sunrise}` and `{sunset}`: that day's times at the location.

For example: `A charming illustration of {condition}, {temperature} degrees Celsius, {daypart}, {season}. Soft colours, no text or lettering.` A prompt without these placeholders never asks for the weather.

With **Weather in (hours)** the placeholders are for a later moment: with `4`, a picture made at 06:50 and shown at 07:00 is about the weather at 11:00 (and `{daypart}` is the light of that hour, so a morning picture for the afternoon is not dark). You can look up to 47 hours ahead; `0` is the weather now.

To draw the weather itself on a picture, see the **Weather bar** of a [schedule](/guide/schedules).

Use **Generate now** in the collection to make a first picture and check the result. Failures (an unreachable service, a refused key) show up on the collection.

### Random choices in a prompt

Write `{pick: one | two | three}` to let the Hub choose one of the options at random for every picture, for example `a vast landscape of {pick: mountains | a rocky coast | a pine forest | rolling hills}`. You can use it several times in one prompt and put other tags inside an option. In the dialog, click the `{pick: … | …}` chip to copy an example. `{pick}` works in every kind of collection.

## 3. Show it on a Canvas

Use the collection in a schedule like any other. Each Canvas shows the newest picture it has not displayed yet.

The Hub starts generating ten minutes before a Canvas is due to change, whatever the mode (push or pull), and tries again every five minutes if it fails. If it keeps failing, the Canvas shows an older picture from the collection instead.

::: tip A fast generator helps
Generation has to finish before the Canvas wakes. A few minutes is fine. If your generator is slower, use a longer schedule interval.
:::

## Storage

Every generated picture is stored on the Hub. By default the Hub keeps the **20 newest** pictures of each AI collection and takes older ones out of it. Change this under the collection's **Settings** (*Pictures to keep*); `0` keeps everything.

- The picture a Canvas is showing right now (or is about to receive) stays until the Canvas changes to another one.
- A picture you also added to another collection (a favourite, say) stays in that collection. It is only deleted from the Hub when no collection has it any more.

This setting is about the Hub's storage. What a Canvas keeps in its own memory follows the Canvas's own settings.

## Good to know

- The Hub adds no caption of its own to AI pictures. The date caption of a schedule still applies if you switch it on there.
- Each picture costs what your generator charges. A schedule that changes every hour with OpenAI generates 24 pictures a day.

## Adding an image provider

The Hub draws its pictures through a small interface, so another service can be added without touching the rest, and a new provider can come as a separate pull request. Gemini, OpenAI and other OpenAI-compatible services share one implementation (`openaiLike`), and ComfyUI has its own.

A provider is an object (`ImageProvider`, in `apps/server/src/lib/ai/providers.ts`) with:

| Field | Meaning |
| --- | --- |
| `id`, `label`, `labelKey` | A stable name that is saved in the settings, and the name shown in Settings: `label` as it is (a brand name), or `labelKey` to translate it. |
| `fields` | The settings it needs (`url`, `apiKey`, `username`, `model`, `size` or `workflow`), each with a type (`text`, `password` or `textarea`), a label, a hint and a placeholder. `advanced: true` puts a field under *Advanced options*. Settings draws exactly these fields. |
| `defaultModel` | Optional. Put in the model field when the service is chosen, and used when it is left empty. |
| `listsModels` | Optional. Set it when `test` returns the models, so Settings offers them as a list. |
| `configured(cfg)` | Whether enough is filled in to try a generation. |
| `generate(cfg, prompt, opts, timeout)` | Draw one picture and return its bytes. Throw an `AiError` with a readable message on failure. |
| `test(cfg)` | Check the address and key without generating anything. Return `{ server }`, a short description of what answered, and `models`, the image models, when the service can list them. |

A hosted service that speaks the OpenAI images API only needs a few lines with `openaiLike`: its id and name, its fixed address, a default model and a test that tells its image models apart.

To add one:

1. Write the provider in `providers.ts` and add it to the `imageProviders` list. Settings, the connection test and the generation pick it up from there.
2. Add the labels and hints of any new field to every language in `apps/web/src/i18n`.
3. Add tests with a stubbed `fetch` (see `apps/server/test/ai.test.ts`); the tests must not call the real service.
4. **Test it against the real service** with a real key before you open the pull request, and say in the description that you did. Only add a service that was tried for real.
