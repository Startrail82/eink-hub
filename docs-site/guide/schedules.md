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

More than one change a day costs battery on battery-powered frames; the UI warns you.

### Several schedules on one frame

Add as many schedules as you like to a frame, for example one collection in the morning and another in the evening. Every schedule changes the picture on its own, at its own time, with its own collection, order, fit and active hours. Nothing has to be "active" at a given moment: whichever schedule comes up changes the picture, and the picture stays until the next change of any schedule.

- Two schedules of the same frame can't change at exactly the same minute (for example `0 20 * * *` twice). The hub tells you which schedule it clashes with.
- Two changes less than 30 minutes apart are allowed but you get a warning: an e-ink refresh takes a while and costs battery. `0 20 * * *` and `5 20 * * *` are fine, just unusual.
- Paused schedules don't take part in the comparison. Resuming one that would clash is refused.
- Hourly schedules are compared by their projected times, so for those the check is approximate.

### Week overview

The **Schedule** page has a **Week view** next to the list of schedules (and every frame's page shows it below its schedules). It lists, per day, at what time the frame changes and to which collection, for the coming seven days.

## How each frame gets the next photo

| Frame | What happens at each change |
| --- | --- |
| BLOOMIN8, push mode | The hub uploads the photo (waking the frame over Bluetooth if you enabled auto-wake). |
| BLOOMIN8, pull mode | The frame wakes at the time the hub gave it, downloads the photo and sleeps until the next change. |
| SwitchBot | The hub sends the photo to SwitchBot's cloud; the frame picks it up on its next check-in. |
| TRMNL / DIY | The frame wakes on its own timer. In each reply the hub tells it how long to sleep: until the next change, but never longer than its *longest sleep* setting, so photos sent by hand don't wait for tomorrow. Outside active hours it sleeps right through. |

**Next** on a frame's page runs the schedule now, and the schedule carries on from there.
