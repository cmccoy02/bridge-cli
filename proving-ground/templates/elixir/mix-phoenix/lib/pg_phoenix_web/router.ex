defmodule PgPhoenixWeb.Router do
  use Phoenix.Router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", PgPhoenixWeb do
    pipe_through :api

    get "/health", PageController, :health
  end
end
