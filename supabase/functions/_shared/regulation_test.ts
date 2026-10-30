import REG from "./regulation/reg_2025_327.json" with { type: "json" };

Deno.test("Art. 54(1) preserves official point labels and their text in order", () => {
  const paragraph = REG.articles["54"].paragraphs.find((p) => p.ref === "1");
  if (!paragraph) throw new Error("Art. 54(1) is missing");

  const points = [
    "(a) taking decisions detrimental to",
    "(b) taking decisions in relation to a natural person or a group of natural persons in relation to job offers,",
    "(c) carrying out advertising or marketing activities;",
    "(d) developing products or services that may harm individuals,",
    "(e) carrying out activities in conflict with ethical provisions laid down in national law.",
  ];
  let previousIndex = -1;
  for (const point of points) {
    const index = paragraph.text.indexOf(point);
    if (index <= previousIndex) {
      throw new Error(`Art. 54(1) point missing or out of order: ${point}`);
    }
    previousIndex = index;
  }
});
