-- M0 conventions check. Run in Roblox Studio (Edit datamodel) through the roblox-studio MCP
-- `execute_luau`, or paste into the command bar. It drops rays onto a WedgePart and a
-- CornerWedgePart and compares the hit heights with the geometry part-builder assumes
-- (src/core/shapes.ts):
--   WedgePart:       top surface y = -hy + sy * (z + hz) / sz      (tall face at +Z / Back)
--   CornerWedgePart: top surface y = min(-hy + sy*(x+hx)/sx, -hy + sy*(hz-z)/sz)
--                    i.e. apex at (+hx, +hy, -hz)
-- Prints CONVENTIONS OK, or the mismatching samples.

local size = Vector3.new(2, 3, 4)
local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2
local origin = Vector3.new(0, 500, 0) -- far from anything in the place

local function probe(className, expected)
	local p = Instance.new(className)
	p.Size = size
	p.Anchored = true
	p.CFrame = CFrame.new(origin)
	p.Parent = workspace
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Include
	params.FilterDescendantsInstances = { p }
	local bad = {}
	local n = 0
	for ix = -3, 3 do
		for iz = -3, 3 do
			local x, z = ix / 3.5 * hx, iz / 3.5 * hz
			local hit = workspace:Raycast(origin + Vector3.new(x, 50, z), Vector3.new(0, -100, 0), params)
			local want = expected(x, z)
			n += 1
			if want > -hy + 1e-3 then -- only where the surface is above the bottom face
				local got = hit and (hit.Position.Y - origin.Y) or -999
				if math.abs(got - want) > 0.05 then
					table.insert(bad, string.format("(%.2f, %.2f): want %.2f got %.2f", x, z, want, got))
				end
			end
		end
	end
	p:Destroy()
	return bad, n
end

local wedgeBad = probe("WedgePart", function(x, z)
	return -hy + size.Y * (z + hz) / size.Z
end)
local cornerBad = probe("CornerWedgePart", function(x, z)
	return math.min(-hy + size.Y * (x + hx) / size.X, -hy + size.Y * (hz - z) / size.Z)
end)

if #wedgeBad == 0 and #cornerBad == 0 then
	print("CONVENTIONS OK: WedgePart and CornerWedgePart match src/core/shapes.ts")
else
	print("WedgePart mismatches: " .. #wedgeBad)
	for _, s in ipairs(wedgeBad) do print("  " .. s) end
	print("CornerWedgePart mismatches: " .. #cornerBad)
	for _, s in ipairs(cornerBad) do print("  " .. s) end
end

-- Visual check of stud surfaces: leaves three studded parts at (0, 0, -20) for a screen_capture.
local folder = workspace:FindFirstChild("ConventionsCheck") or Instance.new("Folder")
folder.Name = "ConventionsCheck"
folder:ClearAllChildren()
folder.Parent = workspace
local studs = Enum.SurfaceType.Studs
for i, cls in ipairs({ "Part", "WedgePart", "CornerWedgePart" }) do
	local p = Instance.new(cls)
	p.Size = Vector3.new(4, 3, 4)
	p.Anchored = true
	p.CFrame = CFrame.new((i - 2) * 6, 1.5, -20)
	p.Color = Color3.fromRGB(70, 130, 200)
	p.Material = Enum.Material.Plastic
	p.TopSurface, p.BottomSurface, p.FrontSurface = studs, studs, studs
	p.BackSurface, p.LeftSurface, p.RightSurface = studs, studs, studs
	p.Name = cls .. "_AllStuds"
	p.Parent = folder
end
print("Placed Workspace.ConventionsCheck (3 studded parts at z = -20): look at them, then delete the folder.")
