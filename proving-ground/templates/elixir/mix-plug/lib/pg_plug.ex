defmodule PgPlug do
  @moduledoc "A tiny JSON responder built on Plug + Jason."

  def health, do: %{ok: true}

  def encode(data), do: Jason.encode!(data)
end
