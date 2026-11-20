export function add(a, b) {
  return a + b;
}

export function App() {
  return (
    <main>
      <h1>Sum: {add(2, 3)}</h1>
    </main>
  );
}
