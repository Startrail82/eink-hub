/**
 * What the hub needs from a weather source, whatever service it comes from. A provider turns
 * its own answer into this neutral snapshot; everything that uses the weather (prompts for AI
 * collections today) is built from the snapshot only, never from a provider's own format.
 */
export interface WeatherSnapshot {
  /** WMO weather interpretation code (0 clear, 3 overcast, 63 rain, 95 thunderstorm...). */
  code: number;
  /** Degrees Celsius. */
  temperature: number;
  /** Today's highest and lowest temperature in degrees Celsius, when the provider has them. */
  high: number | null;
  low: number | null;
  /** Wind speed in km/h, when the provider has it. */
  wind: number | null;
  /** Whether it is day at the location right now. */
  isDay: boolean;
  /** Local time at the location, "YYYY-MM-DDTHH:MM" (no time zone suffix). */
  time: string;
  /** Today's sunrise and sunset, local time at the location in the same format; null when unknown. */
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherRequest {
  latitude: number;
  longitude: number;
  /** The key saved in Settings; empty when none was given. */
  apiKey: string;
}

export interface WeatherProvider {
  /** Stable identifier, saved in the settings. */
  id: string;
  /** Name shown in Settings. */
  name: string;
  /** Whether Settings asks for an API key: not at all, may be left empty, or must be filled in. */
  key: 'none' | 'optional' | 'required';
  /** Current weather and today's figures at a place. Throw an AiError with a readable message when it fails. */
  fetch(req: WeatherRequest): Promise<WeatherSnapshot>;
}
