# Collections & schedules

## Collections

A collection is a set of photos a frame rotates through:

- **Manual**: photos you upload or pick.
- **Immich album / person / favourites / smart search**: kept in sync with [Immich](/guide/immich) automatically.
- **On this day**: Immich memories, captioned "X years ago today".

## Schedules

A frame can have one or more schedules. Each one has its own collection and timing:

- **Every N hours** (1, 3, 6 or 12), optionally only between active hours (e.g. 08:00 to 22:00).
- **Every N days / weeks** at a time, **monthly** on a day, or a **cron** expression.
- **Order**: random (avoiding recent repeats), sequential or newest first.

Changes less than 12 hours apart cost battery on battery-powered frames; the form warns you. Twice a day, 12 hours apart, is fine.

### Several schedules on one frame

Add as many schedules as you like to a frame, for example one collection in the morning and another in the evening. Every schedule changes the picture on its own, at its own time, with its own collection, order, fit and active hours. Nothing has to be "active" at a given moment: whichever schedule comes up changes the picture, and the picture stays until the next change of any schedule.

- Two schedules of the same frame can't change at exactly the same minute (for example `0 20 * * *` twice). The form says which schedule it clashes with while you pick the time, and Save stays off until you change it.
- Two schedules that change less than 12 hours apart are allowed, but the form shows the same battery warning as you pick the time, naming the other schedule. `0 7 * * *` and `0 19 * * *` get no warning; `0 7 * * *` and `20 7 * * *` do.
- Paused schedules don't take part in the comparison. Resuming one that would clash is refused.
- Hourly schedules are compared by their projected times, so for those the check is approximate.

### Week overview

The **Schedule** page has a **Week view** next to the list of schedules (and every frame's page shows it below its schedules). It lists, per day, at what time the frame changes and to which collection, for the coming seven days.

## Label on the photo

A schedule can draw a small label in the bottom-left corner of each photo. Under **Label on the photo**, switch on either or both:

- **Date**: the date it was taken ("X years ago today" for *On this day*).
- **Place**: the city and country where it was taken, from the photo's GPS data. For [Immich](/guide/immich) photos it is the place Immich shows. For photos uploaded to the hub, the hub looks up the nearest town in a built-in list of places ([GeoNames](https://www.geonames.org), CC BY 4.0), with no Immich or internet needed. Photos without GPS data have no place.

With both on, the label reads like `6 October 2019 · Rome, Italy`. With neither, there is no label.

With **Place** on, **Leave out the home country** shows only the city for photos taken in the country of the Canvas's location. That is the hub's location from *Settings → Location*, or the Canvas's own one if you set it under the Canvas's *Settings → Location*.

## How each frame gets the next photo

| Frame | What happens at each change |
| --- | --- |
| BLOOMIN8, push mode | The hub uploads the photo (waking the frame over Bluetooth if you enabled auto-wake). |
| BLOOMIN8, pull mode | The frame wakes at the time the hub gave it, downloads the photo and sleeps until the next change. |
| SwitchBot | The hub sends the photo to SwitchBot's cloud; the frame picks it up on its next check-in. |
| TRMNL / DIY | The frame wakes on its own timer. In each reply the hub tells it how long to sleep: until the next change, but never longer than its *longest sleep* setting, so photos sent by hand don't wait for tomorrow. Outside active hours it sleeps right through. |

**Next** on a frame's page runs the schedule now, and the schedule carries on from there.
