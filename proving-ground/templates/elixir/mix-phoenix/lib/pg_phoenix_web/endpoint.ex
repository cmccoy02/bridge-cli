defmodule PgPhoenixWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :pg_phoenix

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug PgPhoenixWeb.Router
end
