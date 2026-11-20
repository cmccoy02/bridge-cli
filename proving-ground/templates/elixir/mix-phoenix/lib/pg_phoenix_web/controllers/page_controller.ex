defmodule PgPhoenixWeb.PageController do
  use Phoenix.Controller, formats: [:json]

  def health(conn, _params) do
    json(conn, %{ok: true})
  end
end
