defmodule PgPhoenix.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    children = [PgPhoenixWeb.Endpoint]
    Supervisor.start_link(children, strategy: :one_for_one, name: PgPhoenix.Supervisor)
  end

  @impl true
  def config_change(changed, _new, removed) do
    PgPhoenixWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
