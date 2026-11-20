defmodule PgPhoenixWeb.PageControllerTest do
  use PgPhoenixWeb.ConnCase

  test "GET /health returns ok", %{conn: conn} do
    conn = get(conn, "/health")
    assert json_response(conn, 200) == %{"ok" => true}
  end
end
