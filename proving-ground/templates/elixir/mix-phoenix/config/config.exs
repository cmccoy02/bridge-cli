import Config

config :pg_phoenix, PgPhoenixWeb.Endpoint,
  url: [host: "localhost"],
  render_errors: [formats: [json: PgPhoenixWeb.ErrorJSON], layout: false],
  secret_key_base: String.duplicate("a", 64)

config :phoenix, :json_library, Jason

import_config "#{config_env()}.exs"
