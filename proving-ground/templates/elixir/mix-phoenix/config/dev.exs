import Config

config :pg_phoenix, PgPhoenixWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4000],
  debug_errors: true

config :logger, :console, format: "[$level] $message\n"
