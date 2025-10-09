# Weather Data

The system contains stored weather data collected from external sources. This is historical data that has been saved to files.

## Available Fields
- temp: Temperature in Celsius
- humidity: Humidity percentage
- pressure: Atmospheric pressure
- wind_speed: Wind speed
- wind_deg: Wind direction in degrees
- clouds: Cloud coverage percentage
- weather_id: Weather condition ID
- weather_main: Main weather condition (e.g., "Clear", "Rain")
- weather_desc: Detailed weather description

## Date Range
Weather data is available to a current date which is october 2025

## How to Access
Use the weather_fetch tool with appropriate start and end timestamps to retrieve weather data for specific dates.

Example: To get weather for October 2, 2025:
- Convert "October 2, 2025" to Unix timestamps (start and end of day)
- Call weather_fetch with those timestamps
- Retrieve temp, humidity, wind_speed, weather_desc fields