defmodule PgPlugTest do
  use ExUnit.Case

  test "encodes the health payload as JSON" do
    assert PgPlug.encode(PgPlug.health()) == ~s({"ok":true})
  end
end
