defmodule PgPlug.MixProject do
  use Mix.Project

  def project do
    [
      app: :pg_plug,
      version: "0.1.0",
      elixir: "~> 1.17",
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [
      {:plug, "~> 1.15"},
      {:jason, "~> 1.4"}
    ]
  end
end
