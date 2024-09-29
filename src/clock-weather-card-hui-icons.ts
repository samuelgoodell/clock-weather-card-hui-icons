import { LitElement, html, type TemplateResult, type PropertyValues, type CSSResultGroup, svg, SVGTemplateResult } from 'lit'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { customElement, property, state } from 'lit/decorators.js'
import {
  type HomeAssistant,
  hasConfigOrEntityChanged,
  hasAction,
  type ActionHandlerEvent,
  handleAction,
  TimeFormat,
  type ActionConfig
} from 'custom-card-helpers' // This is a community maintained npm module with common helper functions/types. https://github.com/custom-cards/custom-card-helpers

import {
  type ClockWeatherCardConfig,
  type MergedClockWeatherCardConfig,
  type MergedWeatherForecast,
  Rgb,
  type TemperatureSensor,
  type TemperatureUnit,
  type HumiditySensor,
  type Weather,
  WeatherEntityFeature,
  type WeatherForecast,
  type WeatherForecastEvent
} from './types'
import styles from './styles'
import { actionHandler } from './action-handler-directive'
import { localize } from './localize/localize'
import { type HassEntity, type HassEntityBase } from 'home-assistant-js-websocket'
import { extractMostOccuring, max, min, round, roundDown, roundIfNotNull, roundUp } from './utils'
import { version } from '../package.json'
import { safeRender } from './helpers'
import { DateTime } from 'luxon'

console.info(
  `%c  CLOCK-WEATHER-CARD-HUI-ICONS \n%c Version: ${version}`,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray'
);

// This puts your card into the UI card picker dialog
// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'clock-weather-card-hui-icons',
  name: 'Clock Weather Card HUI Icons',
  description: 'Shows the current date/time in combination with the current weather and an iOS insipired weather forecast.'
})

const gradientMap: Map<number, Rgb> = new Map()
  .set(-20, new Rgb(0, 60, 98)) // dark blue
  .set(-10, new Rgb(120, 162, 204)) // darker blue
  .set(0, new Rgb(164, 195, 210)) // light blue
  .set(10, new Rgb(121, 210, 179)) // turquoise
  .set(20, new Rgb(252, 245, 112)) // yellow
  .set(30, new Rgb(255, 150, 79)) // orange
  .set(40, new Rgb(255, 192, 159)) // red

const cloudyStates = new Set<string>([
  "partlycloudy",
  "cloudy",
  "fog",
  "windy",
  "windy-variant",
  "hail",
  "rainy",
  "snowy",
  "snowy-rainy",
  "pouring",
  "lightning",
  "lightning-rainy",
]);
const rainStates = new Set<string>(["hail", "rainy", "pouring"]);
const windyStates = new Set<string>(["windy", "windy-variant"]);
const snowyStates = new Set<string>(["snowy", "snowy-rainy"]);
const lightningStates = new Set<string>(["lightning", "lightning-rainy"]);

@customElement('clock-weather-card-hui-icons')
export class ClockWeatherCardHUIIcons extends LitElement {
  // https://lit.dev/docs/components/properties/
  @property({ attribute: false }) public hass!: HomeAssistant

  @state() private config!: MergedClockWeatherCardConfig
  @state() private currentDate!: DateTime
  @state() private forecasts?: WeatherForecast[]
  @state() private error?: TemplateResult
  private forecastSubscriber?: () => Promise<void>
  private forecastSubscriberLock = false

  constructor () {
    super()
    this.currentDate = DateTime.now()
    const msToNextSecond = (1000 - this.currentDate.millisecond)
    setTimeout(() => setInterval(() => { this.currentDate = DateTime.now() }, 1000), msToNextSecond)
    setTimeout(() => { this.currentDate = DateTime.now() }, msToNextSecond)
  }

  public static getStubConfig (_hass: HomeAssistant, entities: string[], entitiesFallback: string[]): Record<string, unknown> {
    const entity = entities.find(e => e.startsWith('weather.') ?? entitiesFallback.find(() => true))
    if (entity) {
      return { entity }
    }

    return {}
  }

  public getCardSize (): number {
    return 3 + roundUp(this.config.forecast_rows / 2)
  }

  // https://lit.dev/docs/components/properties/#accessors-custom
  public setConfig (config?: ClockWeatherCardConfig): void {
    if (!config) {
      throw this.createError('Invalid configuration.')
    }

    if (!config.entity) {
      throw this.createError('Attribute "entity" must be present.')
    }

    if (config.forecast_rows && config.forecast_rows < 1) {
      throw this.createError('Attribute "forecast_rows" must be greater than 0.')
    }

    if (config.time_format && config.time_format.toString() !== '24' && config.time_format.toString() !== '12') {
      throw this.createError('Attribute "time_format" must either be "12" or "24".')
    }

    if (config.hide_today_section && config.hide_forecast_section) {
      throw this.createError('Attributes "hide_today_section" and "hide_forecast_section" must not enabled at the same time.')
    }

    this.config = this.mergeConfig(config)
  }

  // https://lit.dev/docs/components/lifecycle/#reactive-update-cycle-performing
  protected shouldUpdate (changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false
    }

    if (changedProps.has('forecasts')) {
      return true
    }

    const oldHass = changedProps.get('hass') as HomeAssistant | undefined
    if (oldHass) {
      const oldSun = oldHass.states[this.config.sun_entity]
      const newSun = this.hass.states[this.config.sun_entity]
      if (oldSun !== newSun) {
        return true
      }
    }

    return hasConfigOrEntityChanged(this, changedProps, false)
  }

  protected updated (changedProps: PropertyValues): void {
    super.updated(changedProps)
    if (changedProps.has('config')) {
      void this.subscribeForecastEvents()
    }
  }

  // https://lit.dev/docs/components/rendering/
  protected render (): TemplateResult {
    if (this.error) {
      return this.error
    }

    const showToday = !this.config.hide_today_section
    const showForecast = !this.config.hide_forecast_section
    return html`
      <ha-card
        @action=${(e: ActionHandlerEvent) => { this.handleAction(e) }}
        .actionHandler=${actionHandler({
      hasHold: hasAction(this.config.hold_action as ActionConfig | undefined),
      hasDoubleClick: hasAction(this.config.double_tap_action as ActionConfig | undefined)
    })}
        tabindex="0"
        .label=${`Clock Weather Card: ${this.config.entity || 'No Entity Defined'}`}
      >
        ${this.config.title
        ? html`
          <div class="card-header">
            ${this.config.title}
          </div>`
        : ''}
        <div class="card-content">
          ${showToday
        ? html`
            <clock-weather-card-today>
              ${safeRender(() => this.renderToday())}
            </clock-weather-card-today>`
        : ''}
          ${showForecast
        ? html`
            <clock-weather-card-forecast>
              ${safeRender(() => this.renderForecast())}
            </clock-weather-card-forecast>`
        : ''}
        </div>
      </ha-card>
    `
  }

  public connectedCallback (): void {
    super.connectedCallback()
    if (this.hasUpdated) {
      void this.subscribeForecastEvents()
    }
  }

  public disconnectedCallback (): void {
    super.disconnectedCallback()
    void this.unsubscribeForecastEvents()
  }

  protected willUpdate (changedProps: PropertyValues): void {
    super.willUpdate(changedProps)
    if (!this.forecastSubscriber) {
      void this.subscribeForecastEvents()
    }
  }

  private renderToday (): TemplateResult {
    const weather = this.getWeather()
    const state = weather.state
    const temp = this.config.show_decimal ? this.getCurrentTemperature() : roundIfNotNull(this.getCurrentTemperature())
    const tempUnit = weather.attributes.temperature_unit
    const apparentTemp = this.config.show_decimal ? this.getApparentTemperature() : roundIfNotNull(this.getApparentTemperature())
    const aqi = this.getAqi()
    const aqiColor = this.getAqiColor(aqi)
    const humidity = roundIfNotNull(this.getCurrentHumidity())
    const icon = this.toIcon(state, false)
    const weatherString = this.localize(`weather.${state}`)
    const localizedTemp = temp !== null ? this.toConfiguredTempWithUnit(tempUnit, temp) : null
    const localizedHumidity = humidity !== null ? `${humidity}% ${this.localize('misc.humidity')}` : null
    const localizedApparent = apparentTemp !== null ? this.toConfiguredTempWithUnit(tempUnit, apparentTemp) : null
    const apparentString = this.localize('misc.feels-like')
    const aqiString = this.localize('misc.aqi')

    return html`
      <clock-weather-card-today-left>
        <img class="grow-img" src=${icon} />
      </clock-weather-card-today-left>
      <clock-weather-card-today-right>
        <clock-weather-card-today-right-wrap>
          <clock-weather-card-today-right-wrap-top>
            ${this.config.hide_clock ? weatherString : localizedTemp ? `${weatherString}, ${localizedTemp}` : weatherString}
            ${this.config.show_humidity && localizedHumidity ? html`<br>${localizedHumidity}` : ''}
            ${this.config.apparent_sensor && apparentTemp ? html`<br>${apparentString}: ${localizedApparent}` : ''}
            ${this.config.aqi_sensor && aqi !== null ? html`<br><aqi style="background-color: ${aqiColor}">${aqi} ${aqiString}</aqi>` : ''}
          </clock-weather-card-today-right-wrap-top>
          <clock-weather-card-today-right-wrap-center>
            ${this.config.hide_clock ? localizedTemp ?? 'n/a' : this.time()}
          </clock-weather-card-today-right-wrap-center>
          <clock-weather-card-today-right-wrap-bottom>
            ${this.config.hide_date ? '' : this.date()}
          </clock-weather-card-today-right-wrap-bottom>
        </clock-weather-card-today-right-wrap>
      </clock-weather-card-today-right>`
  }

  private renderForecast (): TemplateResult[] {
    const weather = this.getWeather()
    const currentTemp = roundIfNotNull(this.getCurrentTemperature())
    const maxRowsCount = this.config.forecast_rows
    const hourly = this.config.hourly_forecast
    const temperatureUnit = weather.attributes.temperature_unit

    const forecasts = this.mergeForecasts(maxRowsCount, hourly)

    const minTemps = forecasts.map((f) => f.templow)
    const maxTemps = forecasts.map((f) => f.temperature)
    if (currentTemp !== null) {
      minTemps.push(currentTemp)
      maxTemps.push(currentTemp)
    }
    const minTemp = Math.round(min(minTemps))
    const maxTemp = Math.round(max(maxTemps))

    const gradientRange = this.gradientRange(minTemp, maxTemp, temperatureUnit)

    const displayTexts = forecasts
      .map(f => f.datetime)
      .map(d => hourly ? this.time(d) : this.localize(`day.${d.weekday}`))
    const maxColOneChars = displayTexts.length ? max(displayTexts.map(t => t.length)) : 0

    return forecasts.map((forecast, i) => safeRender(() => this.renderForecastItem(forecast, gradientRange, minTemp, maxTemp, currentTemp, hourly, displayTexts[i], maxColOneChars)))
  }

  private renderForecastItem (forecast: MergedWeatherForecast, gradientRange: Rgb[], minTemp: number, maxTemp: number, currentTemp: number | null, hourly: boolean, displayText: string, maxColOneChars: number): TemplateResult {
    const weatherState = forecast.condition === 'pouring' ? 'raindrops' : forecast.condition === 'rainy' ? 'raindrop' : forecast.condition
    const weatherIcon = this.toIcon(weatherState, true)
    const tempUnit = this.getWeather().attributes.temperature_unit
    const isNow = hourly ? DateTime.now().hour === forecast.datetime.hour : DateTime.now().day === forecast.datetime.day
    const minTempDay = Math.round(isNow && currentTemp !== null ? Math.min(currentTemp, forecast.templow) : forecast.templow)
    const maxTempDay = Math.round(isNow && currentTemp !== null ? Math.max(currentTemp, forecast.temperature) : forecast.temperature)

    return html`
      <clock-weather-card-forecast-row style="--col-one-size: ${(maxColOneChars * 0.5)}rem;">
        ${this.renderText(displayText)}
        ${this.renderIcon(weatherIcon)}
        ${this.renderText(this.toConfiguredTempWithUnit(tempUnit, minTempDay), 'right')}
        ${this.renderForecastTemperatureBar(gradientRange, minTemp, maxTemp, minTempDay, maxTempDay, isNow, currentTemp)}
        ${this.renderText(this.toConfiguredTempWithUnit(tempUnit, maxTempDay))}
      </clock-weather-card-forecast-row>
    `
  }

  private renderText (text: string, textAlign: 'left' | 'center' | 'right' = 'left'): TemplateResult {
    return html`
      <forecast-text style="--text-align: ${textAlign};">
        ${text}
      </forecast-text>
    `
  }

  private renderIcon (src: TemplateResult): TemplateResult {
    return html`
      <forecast-icon>
        ${src}
      </forecast-icon>
    `
  }

  private renderForecastTemperatureBar (gradientRange: Rgb[], minTemp: number, maxTemp: number, minTempDay: number, maxTempDay: number, isNow: boolean, currentTemp: number | null): TemplateResult {
    const { startPercent, endPercent } = this.calculateBarRangePercents(minTemp, maxTemp, minTempDay, maxTempDay)
    const moveRight = maxTemp === minTemp ? 0 : (minTempDay - minTemp) / (maxTemp - minTemp)
    return html`
      <forecast-temperature-bar>
        <forecast-temperature-bar-background> </forecast-temperature-bar-background>
        <forecast-temperature-bar-range
          style="--move-right: ${moveRight}; --start-percent: ${startPercent}%; --end-percent: ${endPercent}%; --gradient: ${this.gradient(
            gradientRange,
            startPercent,
            endPercent
          )};"
        >
          ${isNow ? this.renderForecastCurrentTemp(minTempDay, maxTempDay, currentTemp) : ''}
        </forecast-temperature-bar-range>
      </forecast-temperature-bar>
    `
  }

  private renderForecastCurrentTemp (minTempDay: number, maxTempDay: number, currentTemp: number | null): TemplateResult {
    if (currentTemp == null) {
      return html``
    }
    const indicatorPosition = minTempDay === maxTempDay ? 0 : (100 / (maxTempDay - minTempDay)) * (currentTemp - minTempDay)
    const steps = maxTempDay - minTempDay
    const moveRight = maxTempDay === minTempDay ? 0 : (currentTemp - minTempDay) / steps
    return html`
      <forecast-temperature-bar-current-indicator style="--position: ${indicatorPosition}%;">
        <forecast-temperature-bar-current-indicator-dot style="--move-right: ${moveRight}">
        </forecast-temperature-bar-current-indicator-dot>
      </forecast-temperature-bar-current-indicator>
    `
  }

  // https://lit.dev/docs/components/styles/
  static get styles (): CSSResultGroup {
    return styles
  }

  private gradientRange (minTemp: number, maxTemp: number, temperatureUnit: TemperatureUnit): Rgb[] {
    const minTempCelsius = this.toCelsius(temperatureUnit, minTemp)
    const maxTempCelsius = this.toCelsius(temperatureUnit, maxTemp)
    const minVal = Math.max(roundDown(minTempCelsius, 10), min([...gradientMap.keys()]))
    const maxVal = Math.min(roundUp(maxTempCelsius, 10), max([...gradientMap.keys()]))
    return Array.from(gradientMap.keys())
      .filter((temp) => temp >= minVal && temp <= maxVal)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map((temp) => gradientMap.get(temp)!)
  }

  private gradient (rgbs: Rgb[], fromPercent: number, toPercent: number): string {
    if (rgbs.length <= 1) {
      const rgb = rgbs[0] ?? new Rgb(255, 255, 255)
      return [rgb, rgb]
        .map((rgb) => rgb.toRgbString())
        .join(',')
    }
    const [fromRgb, fromIndex] = this.calculateRgb(rgbs, fromPercent, 'left')
    const [toRgb, toIndex] = this.calculateRgb(rgbs, toPercent, 'right')
    const between = rgbs.slice(fromIndex + 1, toIndex)

    return [fromRgb, ...between, toRgb]
      .map((rgb) => rgb.toRgbString())
      .join(',')
  }

  private calculateRgb (rgbs: Rgb[], percent: number, pickIndex: 'left' | 'right'): [rgb: Rgb, index: number] {
    function valueAtPosition (start: number, end: number, percent: number): number {
      const abs = Math.abs(start - end)
      const value = (abs / 100) * percent
      if (start > end) {
        return round(start - value)
      } else {
        return round(start + value)
      }
    }

    function rgbAtPosition (startIndex: number, endIndex: number, percentToNextIndex: number, rgbs: Rgb[]): Rgb {
      const start = rgbs[startIndex]
      const end = rgbs[endIndex]
      const percent = percentToNextIndex < 0 ? 100 + percentToNextIndex : percentToNextIndex
      const left = percentToNextIndex < 0 ? end : start
      const right = percentToNextIndex < 0 ? start : end
      const r = valueAtPosition(left.r, right.r, percent)
      const g = valueAtPosition(left.g, right.g, percent)
      const b = valueAtPosition(left.b, right.b, percent)
      return new Rgb(r, g, b)
    }

    const steps = 100 / (rgbs.length - 1)
    const step = percent / steps
    const startIndex = Math.round(step)
    const percentToNextIndex = (100 / steps) * (percent - startIndex * steps)
    const endIndex = percentToNextIndex === 0 ? startIndex : percentToNextIndex < 0 ? startIndex - 1 : startIndex + 1
    const rgb = rgbAtPosition(startIndex, endIndex, percentToNextIndex, rgbs)
    const index = pickIndex === 'left' ? Math.min(startIndex, endIndex) : Math.max(startIndex, endIndex)
    return [rgb, index]
  }

  private handleAction (ev: ActionHandlerEvent): void {
    if (this.hass && this.config && ev.detail.action) {
      handleAction(this, this.hass, this.config, ev.detail.action)
    }
  }

  private mergeConfig (config: ClockWeatherCardConfig): MergedClockWeatherCardConfig {
    return {
      ...config,
      sun_entity: config.sun_entity ?? 'sun.sun',
      temperature_sensor: config.temperature_sensor,
      humidity_sensor: config.humidity_sensor,
      weather_icon_type: config.weather_icon_type ?? 'line',
      forecast_rows: config.forecast_rows ?? 5,
      hourly_forecast: config.hourly_forecast ?? false,
      animated_icon: config.animated_icon ?? true,
      time_format: config.time_format?.toString() as '12' | '24' | undefined,
      time_pattern: config.time_pattern ?? undefined,
      show_humidity: config.show_humidity ?? false,
      hide_forecast_section: config.hide_forecast_section ?? false,
      hide_today_section: config.hide_today_section ?? false,
      hide_clock: config.hide_clock ?? false,
      hide_date: config.hide_date ?? false,
      date_pattern: config.date_pattern ?? 'D',
      use_browser_time: config.use_browser_time ?? false,
      time_zone: config.time_zone ?? undefined,
      show_decimal: config.show_decimal ?? false,
      apparent_sensor: config.apparent_sensor ?? undefined,
      aqi_sensor: config.aqi_sensor ?? undefined
    }
  }

  private toIcon (weatherState: string, forceDay: boolean): TemplateResult {
    const daytime = forceDay ? 'day' : this.getSun()?.state === 'below_horizon' ? 'night' : 'day'
    return this.getWeatherStateSVG(weatherState, !daytime);
  }

  private getWeatherStateSVG(
    state: string,
    nightTime?: boolean
  ): SVGTemplateResult {
    return svg`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 17 17"
    >
    ${
      state === "sunny"
        ? svg`
            <path
              class="sun"
              d="m 14.39303,8.4033507 c 0,3.3114723 -2.684145,5.9956173 -5.9956169,5.9956173 -3.3114716,0 -5.9956168,-2.684145 -5.9956168,-5.9956173 0,-3.311471 2.6841452,-5.995617 5.9956168,-5.995617 3.3114719,0 5.9956169,2.684146 5.9956169,5.995617"
            />
          `
        : ""
    }
    ${
      state === "clear-night"
        ? svg`
            <path
              class="moon"
              d="m 13.502891,11.382935 c -1.011285,1.859223 -2.976664,3.121381 -5.2405751,3.121381 -3.289929,0 -5.953329,-2.663833 -5.953329,-5.9537625 0,-2.263911 1.261724,-4.228856 3.120948,-5.240575 -0.452782,0.842738 -0.712753,1.806363 -0.712753,2.832381 0,3.289928 2.663833,5.9533275 5.9533291,5.9533275 1.026017,0 1.989641,-0.259969 2.83238,-0.712752"
            />
          `
        : ""
    }
    ${
      state === "partlycloudy" && nightTime
        ? svg`
            <path
              class="moon"
              d="m14.981 4.2112c0 1.9244-1.56 3.4844-3.484 3.4844-1.9244 0-3.4844-1.56-3.4844-3.4844s1.56-3.484 3.4844-3.484c1.924 0 3.484 1.5596 3.484 3.484"
            />
          `
        : state === "partlycloudy"
          ? svg`
            <path
              class="sun"
              d="m14.981 4.2112c0 1.9244-1.56 3.4844-3.484 3.4844-1.9244 0-3.4844-1.56-3.4844-3.4844s1.56-3.484 3.4844-3.484c1.924 0 3.484 1.5596 3.484 3.484"
            />
          `
          : ""
    }
    ${
      cloudyStates.has(state)
        ? svg`
            <path
              class="cloud-back"
              d="m3.8863 5.035c-0.54892 0.16898-1.04 0.46637-1.4372 0.8636-0.63077 0.63041-1.0206 1.4933-1.0206 2.455 0 1.9251 1.5589 3.4682 3.4837 3.4682h6.9688c1.9251 0 3.484-1.5981 3.484-3.5232 0-1.9251-1.5589-3.5232-3.484-3.5232h-1.0834c-0.25294-1.6916-1.6986-2.9083-3.4463-2.9083-1.7995 0-3.2805 1.4153-3.465 3.1679"
            />
            <path
              class="cloud-front"
              d="m4.1996 7.6995c-0.33902 0.10407-0.64276 0.28787-0.88794 0.5334-0.39017 0.38982-0.63147 0.92322-0.63147 1.5176 0 1.1896 0.96414 2.1431 2.1537 2.1431h4.3071c1.1896 0 2.153-0.98742 2.153-2.1777 0-1.1896-0.96344-2.1777-2.153-2.1777h-0.66992c-0.15593-1.0449-1.0499-1.7974-2.1297-1.7974-1.112 0-2.0274 0.87524-2.1417 1.9586"
            />
          `
        : ""
    }
    ${
      rainStates.has(state)
        ? svg`
            <path
              class="rain"
              d="m5.2852 14.734c-0.22401 0.24765-0.57115 0.2988-0.77505 0.11395-0.20391-0.1845-0.18732-0.53481 0.036689-0.78281 0.14817-0.16298 0.59126-0.32914 0.87559-0.42369 0.12453-0.04092 0.22684 0.05186 0.19791 0.17956-0.065617 0.2921-0.18732 0.74965-0.33514 0.91299"
            />
            <path
              class="rain"
              d="m11.257 14.163c-0.22437 0.24765-0.57115 0.2988-0.77505 0.11395-0.2039-0.1845-0.18768-0.53481 0.03669-0.78281 0.14817-0.16298 0.59126-0.32914 0.8756-0.42369 0.12453-0.04092 0.22684 0.05186 0.19791 0.17956-0.06562 0.2921-0.18732 0.74965-0.33514 0.91299"
            />
            <path
              class="rain"
              d="m8.432 15.878c-0.15452 0.17039-0.3937 0.20567-0.53446 0.07867-0.14041-0.12735-0.12876-0.36865 0.025753-0.53975 0.10195-0.11218 0.40711-0.22684 0.60325-0.29175 0.085725-0.02858 0.15628 0.03563 0.13652 0.12382-0.045508 0.20108-0.12912 0.51647-0.23107 0.629"
            />
            <path
              class="rain"
              d="m7.9991 14.118c-0.19226 0.21237-0.49001 0.25612-0.66499 0.09737-0.17462-0.15804-0.16051-0.45861 0.03175-0.67098 0.12665-0.14005 0.50729-0.28293 0.75071-0.36336 0.10689-0.03563 0.19473 0.0441 0.17004 0.15346-0.056092 0.25082-0.16051 0.64347-0.28751 0.78352"
            />
          `
        : ""
    }
    ${
      state === "pouring"
        ? svg`
            <path
              class="rain"
              d="m10.648 16.448c-0.19226 0.21449-0.49001 0.25894-0.66499 0.09878-0.17498-0.16016-0.16087-0.4639 0.03175-0.67874 0.12665-0.14146 0.50694-0.2854 0.75071-0.36724 0.10689-0.03563 0.19473 0.0448 0.17004 0.15558-0.05645 0.25365-0.16051 0.65017-0.28751 0.79163"
            />
            <path
              class="rain"
              d="m5.9383 16.658c-0.22437 0.25012-0.5715 0.30162-0.77505 0.11501-0.20391-0.18627-0.18768-0.54046 0.036689-0.79093 0.14817-0.1651 0.59126-0.33267 0.87559-0.42827 0.12418-0.04127 0.22648 0.05221 0.19791 0.18168-0.065617 0.29528-0.18732 0.75741-0.33514 0.92251"
            />
          `
        : ""
    }
    ${
      windyStates.has(state)
        ? svg`
            <path
              class="cloud-back"
              d="m 13.59616,15.30968 c 0,0 -0.09137,-0.0071 -0.250472,-0.0187 -0.158045,-0.01235 -0.381353,-0.02893 -0.64382,-0.05715 -0.262466,-0.02716 -0.564444,-0.06385 -0.877358,-0.124531 -0.156986,-0.03034 -0.315383,-0.06844 -0.473781,-0.111478 -0.157691,-0.04551 -0.313266,-0.09842 -0.463902,-0.161219 l -0.267406,-0.0949 c -0.09984,-0.02646 -0.205669,-0.04904 -0.305153,-0.06738 -0.193322,-0.02716 -0.3838218,-0.03316 -0.5640912,-0.02011 -0.3626556,0.02611 -0.6847417,0.119239 -0.94615,0.226483 -0.2617611,0.108656 -0.4642556,0.230364 -0.600075,0.324203 -0.1358195,0.09419 -0.2049639,0.160514 -0.2049639,0.160514 0,0 0.089958,-0.01623 0.24765,-0.04445 0.1559278,-0.02575 0.3764139,-0.06174 0.6367639,-0.08714 0.2596444,-0.02646 0.5591527,-0.0441 0.8678333,-0.02328 0.076905,0.0035 0.1538111,0.01658 0.2321278,0.02293 0.077611,0.01058 0.1534581,0.02893 0.2314221,0.04022 0.07267,0.01834 0.1397,0.03986 0.213078,0.05644 l 0.238125,0.08925 c 0.09207,0.03281 0.183444,0.07055 0.275872,0.09878 0.09243,0.0261 0.185208,0.05327 0.277636,0.07161 0.184856,0.0388 0.367947,0.06174 0.543983,0.0702 0.353131,0.01905 0.678745,-0.01341 0.951442,-0.06456 0.27305,-0.05292 0.494595,-0.123119 0.646642,-0.181681 0.152047,-0.05785 0.234597,-0.104069 0.234597,-0.104069"
            />
            <path
              class="cloud-back"
              d="m 4.7519154,13.905801 c 0,0 0.091369,-0.0032 0.2511778,-0.0092 0.1580444,-0.0064 0.3820583,-0.01446 0.6455833,-0.03281 0.2631722,-0.01729 0.5662083,-0.04269 0.8812389,-0.09137 0.1576916,-0.02434 0.3175,-0.05609 0.4776611,-0.09384 0.1591027,-0.03951 0.3167944,-0.08643 0.4699,-0.14358 l 0.2702277,-0.08467 c 0.1008945,-0.02222 0.2074334,-0.04127 0.3072695,-0.05574 0.1943805,-0.01976 0.3848805,-0.0187 0.5651499,0.0014 0.3608917,0.03951 0.67945,0.144639 0.936625,0.261761 0.2575278,0.118534 0.4554364,0.247297 0.5873754,0.346781 0.132291,0.09913 0.198966,0.168275 0.198966,0.168275 0,0 -0.08925,-0.01976 -0.245886,-0.05397 C 9.9423347,14.087088 9.7232597,14.042988 9.4639681,14.00736 9.2057347,13.97173 8.9072848,13.94245 8.5978986,13.95162 c -0.077258,7.06e-4 -0.1541638,0.01058 -0.2328333,0.01411 -0.077964,0.0078 -0.1545166,0.02328 -0.2331861,0.03175 -0.073025,0.01588 -0.1404055,0.03422 -0.2141361,0.04798 l -0.2420055,0.08008 c -0.093486,0.02963 -0.1859139,0.06421 -0.2794,0.0889 C 7.3028516,14.23666 7.2093653,14.2603 7.116232,14.27512 6.9303181,14.30722 6.7465209,14.3231 6.5697792,14.32486 6.2166487,14.33046 5.8924459,14.28605 5.6218654,14.224318 5.3505793,14.161565 5.1318571,14.082895 4.9822793,14.01869 4.8327015,13.95519 4.7519154,13.905801 4.7519154,13.905801"
            />
          `
        : ""
    }
    ${
      snowyStates.has(state)
        ? svg`
            <path
              class="snow"
              d="m 8.4319893,15.348341 c 0,0.257881 -0.209197,0.467079 -0.467078,0.467079 -0.258586,0 -0.46743,-0.209198 -0.46743,-0.467079 0,-0.258233 0.208844,-0.467431 0.46743,-0.467431 0.257881,0 0.467078,0.209198 0.467078,0.467431"
            />
            <path
              class="snow"
              d="m 11.263878,14.358553 c 0,0.364067 -0.295275,0.659694 -0.659695,0.659694 -0.364419,0 -0.6596937,-0.295627 -0.6596937,-0.659694 0,-0.364419 0.2952747,-0.659694 0.6596937,-0.659694 0.36442,0 0.659695,0.295275 0.659695,0.659694"
            />
            <path
              class="snow"
              d="m 5.3252173,13.69847 c 0,0.364419 -0.295275,0.660047 -0.659695,0.660047 -0.364067,0 -0.659694,-0.295628 -0.659694,-0.660047 0,-0.364067 0.295627,-0.659694 0.659694,-0.659694 0.36442,0 0.659695,0.295627 0.659695,0.659694"
            />
          `
        : ""
    }
    ${
      lightningStates.has(state)
        ? svg`
            <path
              class="sun"
              d="m 9.9252695,10.935875 -1.6483986,2.341014 1.1170184,0.05929 -1.2169864,2.02141 3.0450261,-2.616159 H 9.8864918 L 10.97937,11.294651 10.700323,10.79794 h -0.508706 l -0.2663475,0.137936"
            />
          `
        : ""
    }
    </svg>`;
}

  private getWeather (): Weather {
    const weather = this.hass.states[this.config.entity] as Weather | undefined
    if (!weather) {
      throw this.createError(`Weather entity "${this.config.entity}" could not be found.`)
    }
    return weather
  }

  private getCurrentTemperature (): number | null {
    if (this.config.temperature_sensor) {
      const temperatureSensor = this.hass.states[this.config.temperature_sensor] as TemperatureSensor | undefined
      const temp = temperatureSensor?.state ? parseFloat(temperatureSensor.state) : undefined
      const unit = temperatureSensor?.attributes.unit_of_measurement ?? this.getConfiguredTemperatureUnit()
      if (temp !== undefined && !isNaN(temp)) {
        return this.toConfiguredTempWithoutUnit(unit, temp)
      }
    }

    // return weather temperature if above code could not extract temperature from temperature_sensor
    return this.getWeather().attributes.temperature ?? null
  }

  private getCurrentHumidity (): number | null {
    if (this.config.humidity_sensor) {
      const humiditySensor = this.hass.states[this.config.humidity_sensor] as HumiditySensor | undefined
      const humid = humiditySensor?.state ? parseFloat(humiditySensor.state) : undefined
      if (humid !== undefined && !isNaN(humid)) {
        return humid
      }
    }

    // Return weather humidity if the code could not extract humidity from the humidity_sensor
    return this.getWeather().attributes.humidity ?? null
  }

  private getApparentTemperature (): number | null {
    if (this.config.apparent_sensor) {
      const apparentSensor = this.hass.states[this.config.apparent_sensor] as TemperatureSensor | undefined
      const temp = apparentSensor?.state ? parseFloat(apparentSensor.state) : undefined
      const unit = apparentSensor?.attributes.unit_of_measurement ?? this.getConfiguredTemperatureUnit()
      if (temp !== undefined && !isNaN(temp)) {
        return this.toConfiguredTempWithoutUnit(unit, temp)
      }
    }
    return null
  }

  private getAqi (): number | null {
    if (this.config.aqi_sensor) {
      const aqiSensor = this.hass.states[this.config.aqi_sensor] as HassEntity | undefined
      const aqi = aqiSensor?.state ? parseInt(aqiSensor.state) : undefined
      if (aqi !== undefined && !isNaN(aqi)) {
        return aqi
      }
    }
    return null
  }

  private getAqiColor (aqi: number | null): string | null {
    if (aqi == null) {
      return null
    }
    if (aqi <= 50) return 'green'
    if (aqi <= 100) return 'yellowgreen'
    if (aqi <= 150) return 'orange'
    if (aqi <= 200) return 'red'
    if (aqi <= 300) return 'purple'
    return 'maroon'
  }

  private getSun (): HassEntityBase | undefined {
    return this.hass.states[this.config.sun_entity]
  }

  private getLocale (): string {
    return this.config.locale ?? this.hass.locale.language ?? 'en-GB'
  }

  private date (): string {
    return this.toZonedDate(this.currentDate).toFormat(this.config.date_pattern)
  }

  private time (date: DateTime = this.currentDate): string {
    if (this.config.time_pattern) {
      return this.toZonedDate(date).toFormat(this.config.time_pattern)
    }

    if (this.config.time_format) {
      return this.toZonedDate(date)
        .toFormat(this.config.time_format === '24' ? 'HH:mm' : 'h:mm a')
    }
    if (this.hass.locale.time_format === TimeFormat.am_pm) {
      return this.toZonedDate(date).toFormat('h:mm a')
    }

    if (this.hass.locale.time_format === TimeFormat.twenty_four) {
      return this.toZonedDate(date).toFormat('HH:mm')
    }

    return this.toZonedDate(date).toFormat('t')
  }

  private getIconAnimationKind (): 'static' | 'animated' {
    return this.config.animated_icon ? 'animated' : 'static'
  }

  private toCelsius (temperatueUnit: TemperatureUnit, temperature: number): number {
    return temperatueUnit === '°C' ? temperature : Math.round((temperature - 32) * (5 / 9))
  }

  private toFahrenheit (temperatueUnit: TemperatureUnit, temperature: number): number {
    return temperatueUnit === '°F' ? temperature : Math.round((temperature * 9 / 5) + 32)
  }

  private getConfiguredTemperatureUnit (): TemperatureUnit {
    return this.hass.config.unit_system.temperature as TemperatureUnit
  }

  private toConfiguredTempWithUnit (unit: TemperatureUnit, temp: number): string {
    const convertedTemp = this.toConfiguredTempWithoutUnit(unit, temp)
    // return convertedTemp + this.getConfiguredTemperatureUnit()
    return convertedTemp + "°";
  }

  private toConfiguredTempWithoutUnit (unit: TemperatureUnit, temp: number): number {
    const configuredUnit = this.getConfiguredTemperatureUnit()
    if (configuredUnit === unit) {
      return temp
    }

    return unit === '°C'
      ? this.toFahrenheit(unit, temp)
      : this.toCelsius(unit, temp)
  }

  private calculateBarRangePercents (minTemp: number, maxTemp: number, minTempDay: number, maxTempDay: number): { startPercent: number, endPercent: number } {
    if (maxTemp === minTemp) {
      // avoid division by 0
      return { startPercent: 0, endPercent: 100 }
    }
    const startPercent = (100 / (maxTemp - minTemp)) * (minTempDay - minTemp)
    const endPercent = (100 / (maxTemp - minTemp)) * (maxTempDay - minTemp)
    // fix floating point issue
    // (100 / (19 - 8)) * (19 - 8) = 100.00000000000001
    return {
      startPercent: Math.max(0, startPercent),
      endPercent: Math.min(100, endPercent)
    }
  }

  private localize (key: string): string {
    return localize(key, this.getLocale())
  }

  private mergeForecasts (maxRowsCount: number, hourly: boolean): MergedWeatherForecast[] {
    const forecasts = this.isLegacyWeather() ? this.getWeather().attributes.forecast ?? [] : this.forecasts ?? []
    const agg = forecasts.reduce<Record<number, WeatherForecast[]>>((forecasts, forecast) => {
      const d = new Date(forecast.datetime)
      const unit = hourly ? `${d.getMonth()}-${d.getDate()}-${+d.getHours()}` : d.getDate()
      forecasts[unit] = forecasts[unit] || []
      forecasts[unit].push(forecast)
      return forecasts
    }, {})

    return Object.values(agg)
      .reduce((agg: MergedWeatherForecast[], forecasts) => {
        if (forecasts.length === 0) return agg
        const avg = this.calculateAverageForecast(forecasts)
        agg.push(avg)
        return agg
      }, [])
      .sort((a, b) => a.datetime.toMillis() - b.datetime.toMillis())
      .slice(0, maxRowsCount)
  }

  private toZonedDate (date: DateTime): DateTime {
    const localizedDate = date.setLocale(this.getLocale())
    if (this.config.use_browser_time) return localizedDate
    const timeZone = this.config.time_zone ?? this.hass?.config?.time_zone
    const withTimeZone = localizedDate.setZone(timeZone)
    if (withTimeZone.isValid) {
      return withTimeZone
    }
    console.error(`clock-weather-card-hui-icons - Time Zone [${timeZone}] not supported. Falling back to browser time.`)
    return localizedDate
  }

  private calculateAverageForecast (forecasts: WeatherForecast[]): MergedWeatherForecast {
    const minTemps = forecasts.map((f) => f.templow ?? f.temperature ?? this.getCurrentTemperature() ?? 0)
    const minTemp = min(minTemps)

    const maxTemps = forecasts.map((f) => f.temperature ?? this.getCurrentTemperature() ?? 0)
    const maxTemp = max(maxTemps)

    const precipitationProbabilities = forecasts.map((f) => f.precipitation_probability ?? 0)
    const precipitationProbability = max(precipitationProbabilities)

    const precipitations = forecasts.map((f) => f.precipitation ?? 0)
    const precipitation = max(precipitations)

    const conditions = forecasts.map((f) => f.condition)
    const condition = extractMostOccuring(conditions)

    return {
      temperature: maxTemp,
      templow: minTemp,
      datetime: this.parseDateTime(forecasts[0].datetime),
      condition,
      precipitation_probability: precipitationProbability,
      precipitation
    }
  }

  private async subscribeForecastEvents (): Promise<void> {
    if (this.forecastSubscriberLock) {
      return
    }
    this.forecastSubscriberLock = true
    await this.unsubscribeForecastEvents()
    if (this.isLegacyWeather()) {
      this.forecastSubscriber = async () => {}
      this.forecastSubscriberLock = false
      return
    }

    if (!this.isConnected || !this.config || !this.hass) {
      this.forecastSubscriberLock = false
      return
    }

    const forecastType = this.determineForecastType()
    if (forecastType === 'hourly_not_supported') {
      this.forecastSubscriber = async () => {}
      this.forecastSubscriberLock = false
      throw this.createError(`Weather entity [${this.config.entity}] does not support hourly forecast.`)
    }
    try {
      const callback = (event: WeatherForecastEvent): void => {
        this.forecasts = event.forecast
      }
      const options = { resubscribe: false }
      const message = {
        type: 'weather/subscribe_forecast',
        forecast_type: forecastType,
        entity_id: this.config.entity
      }
      this.forecastSubscriber = await this.hass.connection.subscribeMessage<WeatherForecastEvent>(callback, message, options)
    } catch (e: unknown) {
      console.error('clock-weather-card-hui-icons - Error when subscribing to weather forecast', e)
    } finally {
      this.forecastSubscriberLock = false
    }
  }

  private async unsubscribeForecastEvents (): Promise<void> {
    if (this.forecastSubscriber) {
      try {
        await this.forecastSubscriber()
      } catch (e: unknown) {
        // swallow error, as this means that connection was closed already
      } finally {
        this.forecastSubscriber = undefined
      }
    }
  }

  private isLegacyWeather (): boolean {
    return !this.supportsFeature(WeatherEntityFeature.FORECAST_DAILY) && !this.supportsFeature(WeatherEntityFeature.FORECAST_HOURLY)
  }

  private supportsFeature (feature: WeatherEntityFeature): boolean {
    try {
      return (this.getWeather().attributes.supported_features & feature) !== 0
    } catch (e) {
      // might be that weather entity was not found
      return false
    }
  }

  private createError (errorString: string): Error {
    const error = new Error(errorString)
    const errorCard = document.createElement('hui-error-card')
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config
    })
    this.error = html`${errorCard}`
    return error
  }

  private determineForecastType (): 'hourly' | 'daily' | 'hourly_not_supported' {
    const supportsDaily = this.supportsFeature(WeatherEntityFeature.FORECAST_DAILY)
    const supportsHourly = this.supportsFeature(WeatherEntityFeature.FORECAST_HOURLY)
    const hourly = this.config.hourly_forecast
    if (supportsDaily && supportsHourly) {
      return hourly ? 'hourly' : 'daily'
    } else if (hourly && supportsHourly) {
      return 'hourly'
    } else if (!hourly && supportsDaily) {
      return 'daily'
    } else if (hourly && !supportsHourly) {
      return 'hourly_not_supported'
    } else {
      // !hourly && !supportsDaily
      console.warn(`clock-weather-card-hui-icons - Weather entity [${this.config.entity}] does not support daily forecast. Falling back to hourly forecast.`)
      return 'hourly'
    }
  }

  private parseDateTime (date: string): DateTime {
    const fromIso = DateTime.fromISO(date)
    if (fromIso.isValid) {
      return fromIso
    }
    return DateTime.fromJSDate(new Date(date))
  }
}
