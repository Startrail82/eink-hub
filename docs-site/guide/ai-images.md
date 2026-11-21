# AI images

An **AI collection** fills itself with pictures drawn by an image generator: a cartoon about today's headline, an illustration of the weather, or anything you can describe in a prompt. The Hub makes each picture shortly before a Canvas changes, so a new one is ready when the Canvas wakes up.

## 1. Connect a generator

Open **Settings > AI images** (admins only). One connection is used by the whole Hub.

### OpenAI or a compatible service

| Field | What to enter |
| --- | --- |
| Address | The base address up to and including `/v1`. Leave empty to use OpenAI itself. For a local service this is something like `http://192.168.1.30:8080/v1`. |
| API key | Your key. It is stored on the Hub and never shown again; leave the field empty to keep the saved one. |
| Model | The model name, for example `gpt-image-1`. |
| Image size | Optional, for example `1024x1536`. Empty picks a size that matches the Canvas. |

Anything that implements `POST /v1/images/generations` works.

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
| `"{{seed}}"` | A random number. Write it as a string; the Hub turns it into a number. |
| `"{{width}}"`, `"{{height}}"` | The size for the Canvas, as numbers. |

**Test connection** checks the address (and your key) without generating a picture.

## 2. Create an AI collection

In the **Library**, choose **New AI collection** and pick what to draw:

- **A fixed prompt.** The same description every time. The result still differs from picture to picture. `{date}`, `{time}` (the nearest full hour, like `14:00`) and `{season}` can be used in it. `{date}`, `{time}` and `{season}` work in every kind of collection.
- **An RSS feed.** Each picture is made from the newest feed item that has not been drawn yet. When all items were drawn, it starts again with the newest. Leave the prompt empty for a cartoon of the headline, or write your own with `{title}` and `{description}`. RSS 2.0 and Atom are supported.
- **The weather.** Uses [Open-Meteo](https://open-meteo.com/) for a latitude and longitude (no account needed). Leave the prompt empty for a weather illustration, or write your own with `{condition}`, `{temperature}`, `{high}`, `{low}`, `{wind}`, `{daypart}`, `{sunrise}`, `{sunset}` and `{season}`. `{condition}` describes the weather the way a picture can show it, for example `steady rain, rain streaks falling, wet glistening ground with puddle reflections`, `snowfall, snowflakes drifting through the air, snow-covered ground` or, by night, `clear sky with a bright moon and stars`. `{daypart}` is `night time, dark night`, `sunrise, soft golden light on the horizon` (within 45 minutes of sunrise), `day time` or `sunset, warm glowing sky` (within 45 minutes of sunset), for the hour of the picture. `{sunrise}` and `{sunset}` are today's times at the location.

Choose the **Frame type** (screen) and **orientation** the pictures are made for. They are generated at that screen's shape, so they fit without cropping. When you later use the collection on a Canvas with a different resolution or orientation, the Hub warns you that the pictures will be cropped or scaled.

Use **Generate now** in the collection to make a first picture and check the result. Failures (an unreachable service, a refused key) show up on the collection.

## 3. Show it on a Canvas

Use the collection in a schedule like any other. Frames show the newest picture they have not displayed yet.

The Hub starts generating ten minutes before a Canvas is due to change, whatever the mode (push or pull), and tries again every five minutes if it fails. If it keeps failing, the Canvas shows an older picture from the collection instead.

::: tip A fast generator helps
Generation has to finish before the Canvas wakes. A few minutes is fine. If your generator is slower, use a longer schedule interval.
:::

## Storage

By default the Hub keeps the **20 newest** pictures of each AI collection and removes older ones. Change this under the collection's **Settings** (*Pictures to keep*); `0` keeps everything. A picture that is currently on a Canvas is never removed.

## Good to know

- The Hub adds no caption of its own to AI pictures. The date caption of a schedule still applies if you switch it on there.
- Each picture costs what your generator charges. A schedule that changes every hour with OpenAI generates 24 pictures a day.
