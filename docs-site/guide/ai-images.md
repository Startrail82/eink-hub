# AI images

An **AI collection** fills itself with pictures drawn by an image generator: a cartoon about today's headline, or anything you can describe in a prompt. The Hub makes each picture shortly before a Canvas changes, so a new one is ready when the Canvas wakes up.

## 1. Connect a generator

Open **Settings > AI images** (admins only). One connection is used by the whole Hub.

### OpenAI or a compatible service

| Field | What to enter |
| --- | --- |
| Address | The base address up to and including `/v1`. Leave empty to use OpenAI itself. For a local service this is something like `http://192.168.1.30:8080/v1`. |
| API key | Your key. It is stored on the Hub and never shown again; leave the field empty to keep the saved one. |
| Model | The model name, for example `gpt-image-1`. |
| Image size | Optional, for example `1024x1536`. Empty picks a size that matches the Canvas. Enter `none` for a service that does not accept a size (xAI's image API is reported to reject it), and no size is sent. |

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

Choose the **Frame type** (screen) and **orientation** the pictures are made for. They are generated at that screen's shape, so they fit without cropping. When you later use the collection on a Canvas with a different resolution or orientation, the Hub warns you that the pictures will be cropped or scaled.

Use **Generate now** in the collection to make a first picture and check the result. Failures (an unreachable service, a refused key) show up on the collection.

## 3. Show it on a Canvas

Use the collection in a schedule like any other. Frames show the newest picture they have not displayed yet.

The Hub starts generating ten minutes before a Canvas is due to change, whatever the mode (push or pull), and tries again every five minutes if it fails. If it keeps failing, the Canvas shows an older picture from the collection instead.

::: tip A fast generator helps
Generation has to finish before the Canvas wakes. A few minutes is fine. If your generator is slower, use a longer schedule interval.
:::

## Storage

By default the Hub keeps the **20 newest** pictures of each AI collection and takes older ones out of it. Change this under the collection's **Settings** (*Pictures to keep*); `0` keeps everything. A picture that is currently on a Canvas is never taken out. A picture you also added to another collection (a favourite, say) stays in that collection; it is only deleted when no collection has it any more.

## Good to know

- The Hub adds no caption of its own to AI pictures. The date caption of a schedule still applies if you switch it on there.
- Each picture costs what your generator charges. A schedule that changes every hour with OpenAI generates 24 pictures a day.

## Adding an image provider

The Hub draws its pictures through a small interface, so another service can be added without touching the rest, and a new provider can come as a separate pull request. The first two are OpenAI-compatible services and ComfyUI.

A provider is an object (`ImageProvider`, in `apps/server/src/lib/ai/providers.ts`) with:

| Field | Meaning |
| --- | --- |
| `id`, `label` | A stable name that is saved in the settings, and the name shown in Settings. |
| `fields` | The settings it needs (`url`, `apiKey`, `username`, `model`, `size` or `workflow`), each with a type (`text`, `password` or `textarea`), a label, a hint and a placeholder. Settings draws exactly these fields. |
| `presets` | Optional shortcuts that fill in `url`, `model` and `size`, for a service that is OpenAI-compatible. |
| `configured(cfg)` | Whether enough is filled in to try a generation. |
| `generate(cfg, prompt, opts, timeout)` | Draw one picture and return its bytes. Throw an `AiError` with a readable message on failure. |
| `test(cfg)` | Check the address and key without generating anything, and return a short description of what answered. |

To add one:

1. Write the provider in `providers.ts` and add it to the `imageProviders` list. Settings, the connection test and the generation pick it up from there.
2. Add the labels and hints of any new field to every language in `apps/web/src/i18n`.
3. Add tests with a stubbed `fetch` (see `apps/server/test/ai.test.ts`); the tests must not call the real service.
4. **Test it against the real service** with a real key before you open the pull request, and say in the description that you did. This goes for presets too: a preset (a base address, a default model and whether the service accepts `size`) is only added for a service that was tried for real.
