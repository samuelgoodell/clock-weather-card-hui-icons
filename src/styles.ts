import { css } from 'lit'

export default [
  // weatherSVGStyles from homeassistant/frontend/src/data/weather.ts
  css`
  .rain {
    fill: var(--weather-icon-rain-color, #30b3ff);
  }
  .sun {
    fill: var(--weather-icon-sun-color, #fdd93c);
  }
  .moon {
    fill: var(--weather-icon-moon-color, #fcf497);
  }
  .cloud-back {
    fill: var(--weather-icon-cloud-back-color, #d4d4d4);
  }
  .cloud-front {
    fill: var(--weather-icon-cloud-front-color, #f9f9f9);
  }
  .snow {
    fill: var(--weather-icon-snow-color, #f9f9f9);
    stroke: var(--weather-icon-snow-stroke-color, #d4d4d4);
    stroke-width: 1;
    paint-order: stroke;
  }
  `,
  css`
    ha-card {
      --bar-height: 1.5rem;
      height: 100%;
    }

    clock-weather-card-today {
      display: flex;
    }

    clock-weather-card-today-left {
      display: flex;
      width: 35%;
      align-items: center;
      justify-content: center;
    }

    clock-weather-card-today-right {
      display: flex;
      width: 65%;
      justify-content: space-around;
      align-items: center;
    }

    clock-weather-card-today-right-wrap {
      display: flex;
      flex-direction: column;
    }

    clock-weather-card-today-right-wrap-top {
      width: 100%;
      text-align: end;
      display: block;
    }

    clock-weather-card-today-right-wrap-center {
      display: flex;
      height: 4rem;
      font-size: 3.5rem;
      white-space: nowrap;
      align-items: center;
      justify-content: center;
    }

    clock-weather-card-today-right-wrap-bottom {
      display: flex;
      justify-content: start;
    }

    clock-weather-card-forecast {
      display: block;
    }

    clock-weather-card-forecast-row {
      display: grid;
      grid-template-columns: var(--col-one-size) 2rem 2.1rem auto 2.1rem;
      align-items: center;
      grid-gap: 0.5rem;
    }

    forecast-text {
      text-align: var(--text-align);
      white-space: nowrap;
      text-overflow: clip;
    }

    forecast-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    forecast-icon > svg {
      width: 24px;
      height: 24px;
      margin: 2px;
    }

    forecast-temperature-bar {
      position: relative;
      width: 100%;
      height: var(--bar-height);
      border-radius: calc(var(--bar-height) / 2);
      overflow: hidden;
    }

    forecast-temperature-bar-background {
      left: 0%;
      right: 100%;
      width: 100%;
      opacity: 0.25;
      background: var(--light-primary-color);
    }

    forecast-temperature-bar-current-indicator-dot {
      --border-width: 4px;
      background-color: var(--primary-text-color);
      border-radius: 50%;
      width: var(--bar-height);
      border: var(--border-width) solid var(--ha-card-background,var(--card-background-color,#fff));
      margin-left: calc(var(--move-right) * -1 * var(--bar-height) - var(--border-width));
      margin-top: calc(-1 * var(--border-width));
    }

    forecast-temperature-bar-range {
      border-radius: calc(var(--bar-height) / 2);
      left: var(--start-percent);
      right: calc(100% - var(--end-percent));
      background: linear-gradient(to right, var(--gradient));
      overflow: visible;
      min-width: var(--bar-height);
      margin-left: calc(var(--move-right) * -1 * var(--bar-height));
    }

    forecast-temperature-bar-current-indicator {
      opacity: 1;
      left: var(--position);
    }

    forecast-temperature-bar-current-indicator,
    forecast-temperature-bar-current-indicator-dot,
    forecast-temperature-bar-background,
    forecast-temperature-bar-range {
      height: 100%;
      position: absolute;
    }

    aqi {
      padding: 2px;
      border-radius: 5px;
    }
  `
]
